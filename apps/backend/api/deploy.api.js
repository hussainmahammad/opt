const router = require("express").Router();
const axios = require("axios");
const AWS = require("aws-sdk");
const { watchDeployment } = require("../workers/deploymentWatcher");

/* ================= ENV ================= */

const {
  JENKINS_URL,
  JENKINS_USER,
  JENKINS_API_TOKEN,
  AWS_REGION
} = process.env;

const auth = {
  username: JENKINS_USER,
  password: JENKINS_API_TOKEN
};

AWS.config.update({ region: AWS_REGION || "us-east-1" });
const dynamodb = new AWS.DynamoDB.DocumentClient();

/* ================= SAFE UPDATE ================= */

async function updateDeployment(deploymentId, data) {
  const updates = [];
  const values = {};
  const names = {};

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;

    updates.push(`#${key} = :${key}`);
    values[`:${key}`] = value;
    names[`#${key}`] = key;
  }

  if (!updates.length) return;

  await dynamodb.update({
    TableName: "Deployments",
    Key: { deploymentId },
    UpdateExpression: "SET " + updates.join(", "),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values
  }).promise();
}

/* ================= HELPERS ================= */

async function getApplication(appId) {
  const result = await dynamodb.get({
    TableName: "Applications",
    Key: { appId }
  }).promise();

  return result.Item;
}

async function getBuildNumberFromQueue(queueUrl) {
  while (true) {
    const res = await axios.get(`${queueUrl}api/json`, { auth });

    if (res.data.executable?.number) {
      return res.data.executable.number;
    }

    await new Promise(r => setTimeout(r, 1000));
  }
}

/* ================= DEPLOY API ================= */

router.post("/deploy", async (req, res) => {
  try {
    const { appId, runtime } = req.body;

    /* ===== 1. Basic Validation ===== */

    if (!appId || !runtime) {
      return res.status(400).json({
        error: "appId and runtime required"
      });
    }

    const allowedRuntimes = ["ec2", "eks-fargate", "eks-ec2"];

    if (!allowedRuntimes.includes(runtime)) {
      return res.status(400).json({
        error: "Invalid runtime"
      });
    }

    /* ===== 2. Fetch Application ===== */

    const app = await getApplication(appId);

    if (!app) {
      return res.status(404).json({
        error: "Application not found"
      });
    }

    const {
      appName,
      deployJobName,
      destroyJobName,
      ec2Support,
      eksFargateSupport,
      eksEc2Support
    } = app;

    /* ===== 3. Validate Runtime Support ===== */

    if (runtime === "ec2" && !ec2Support) {
      return res.status(400).json({
        error: "EC2 not supported for this application"
      });
    }

    if (runtime === "eks-fargate" && !eksFargateSupport) {
      return res.status(400).json({
        error: "EKS Fargate not supported for this application"
      });
    }

    if (runtime === "eks-ec2" && !eksEc2Support) {
      return res.status(400).json({
        error: "EKS EC2 not supported for this application"
      });
    }

    /* ===== 4. Create Deployment ID ===== */

    const deploymentId = `dep-${Date.now()}`;
    const createdAt = new Date().toISOString();

    /* ===== 5. Insert Initial Deployment Record ===== */

    await dynamodb.put({
      TableName: "Deployments",
      Item: {
        deploymentId,
        appId,
        appName,
        runtime,

        /* Pipeline */
        deployJobName,
        destroyJobName,
        deployBuildNumber: "NA",
        destroyBuildNumber: "NA",

        /* Status */
        status: "QUEUED",
        createdAt,
        completedAt: "NA",
        destroyedAt: "NA",

        /* Endpoint */
        endpointUrl: "NA",

        /* Logs */
        logGroupAccess: "NA",
        logGroupError: "NA",
        logGroup: "NA",

        /* Metrics */
        metricsEnabled: false,
        metricsType: "NA",

        /* EC2 */
        asgName: "NA",

        /* EKS */
        clusterName: "NA",
        namespace: "NA",
        deploymentName: "NA"
      }
    }).promise();

    /* ===== 6. Trigger Jenkins ===== */

    const triggerResponse = await axios.post(
      `${JENKINS_URL}/job/${deployJobName}/buildWithParameters`,
      null,
      {
        auth,
        params: {
          APP_ID: appId,
          APP_NAME: appName,
          DEPLOY_TARGET: runtime
        }
      }
    );

    /* ===== 7. Get Build Number ===== */

    const deployBuildNumber = await getBuildNumberFromQueue(
      triggerResponse.headers.location
    );

    /* ===== 8. Update Status → DEPLOYING ===== */

    await updateDeployment(deploymentId, {
      deployBuildNumber,
      status: "DEPLOYING"
    });

    /* ===== 9. Start Watcher ===== */

    watchDeployment({
      deploymentId,
      jobName: deployJobName,
      buildNumber: deployBuildNumber,
      runtime,
      appId,
      appName,
      updateDeployment
    });

    /* ===== 10. Response ===== */

    res.json({
      message: "Deployment started",
      deploymentId,
      appId,
      appName,
      runtime,
      deployJobName,
      destroyJobName,
      deployBuildNumber
    });

  } catch (error) {
    console.error("Deploy API Error:", error.message);

    res.status(500).json({
      error: "Deployment failed"
    });
  }
});

module.exports = router;
