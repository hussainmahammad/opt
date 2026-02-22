const router = require("express").Router();
const axios = require("axios");
const AWS = require("aws-sdk");

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

/* ================= HELPERS ================= */

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function getDeployment(deploymentId) {
  const res = await dynamodb.get({
    TableName: "Deployments",
    Key: { deploymentId }
  }).promise();

  return res.Item;
}

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

async function getBuildNumberFromQueue(queueUrl) {
  while (true) {
    const res = await axios.get(`${queueUrl}api/json`, { auth });
    const buildNumber = res.data.executable?.number;

    if (buildNumber) return buildNumber;

    await wait(1000);
  }
}

/* ================= DESTROY WATCHER ================= */

async function watchDestroy({ jobName, buildNumber, deploymentId }) {
  console.log("Destroy watcher started:", deploymentId);

  while (true) {
    try {
      const res = await axios.get(
        `${JENKINS_URL}/job/${jobName}/${buildNumber}/api/json`,
        { auth }
      );

      if (!res.data.building) {
        const success = res.data.result === "SUCCESS";

        await updateDeployment(deploymentId, {
          status: success ? "DESTROYED" : "FAILED",
          destroyedAt: new Date().toISOString(),
          destroyBuildNumber: buildNumber
        });

        console.log(
          success
            ? `Deployment destroyed: ${deploymentId}`
            : `Destroy failed: ${deploymentId}`
        );

        break;
      }

    } catch (err) {
      console.error("Destroy watcher error:", err.message);
    }

    await wait(10000); // poll every 10s
  }
}

/* ================= DESTROY API ================= */

router.post("/destroy", async (req, res) => {
  try {
    const { deploymentId } = req.body;

    if (!deploymentId) {
      return res.status(400).json({
        error: "deploymentId required"
      });
    }

    /* ===== 1. Fetch Deployment ===== */

    const dep = await getDeployment(deploymentId);

    if (!dep) {
      return res.status(404).json({
        error: "Deployment not found"
      });
    }

    if (dep.status === "DESTROYED") {
      return res.json({
        deploymentId,
        status: "ALREADY_DESTROYED"
      });
    }

    const {
      destroyJobName,
      runtime,
      appId,
      appName
    } = dep;

    if (!destroyJobName || destroyJobName === "NA") {
      return res.status(400).json({
        error: "Destroy job not configured"
      });
    }

    /* ===== 2. Trigger Jenkins Destroy ===== */

    const triggerRes = await axios.post(
      `${JENKINS_URL}/job/${destroyJobName}/buildWithParameters`,
      null,
      {
        auth,
        params: {
          APP_ID: appId,
          APP_NAME: appName,
          DESTROY_TARGET: runtime
        }
      }
    );

    /* ===== 3. Get Build Number ===== */

    const destroyBuildNumber = await getBuildNumberFromQueue(
      triggerRes.headers.location
    );

    /* ===== 4. Update status → DESTROYING ===== */

    await updateDeployment(deploymentId, {
      status: "DESTROYING",
      destroyBuildNumber
    });

    /* ===== 5. Start Destroy Watcher ===== */

    watchDestroy({
      jobName: destroyJobName,
      buildNumber: destroyBuildNumber,
      deploymentId
    });

    /* ===== 6. Response ===== */

    res.json({
      message: "Destroy started",
      deploymentId,
      runtime,
      destroyJobName,
      destroyBuildNumber,
      status: "DESTROYING"
    });

  } catch (err) {
    console.error("Destroy API error:", err.message);

    res.status(500).json({
      error: "Failed to destroy deployment"
    });
  }
});

module.exports = router;
