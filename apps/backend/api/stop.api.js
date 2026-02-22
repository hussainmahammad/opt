const router = require("express").Router();
const axios = require("axios");
const AWS = require("aws-sdk");

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

/* =========================================================
   Helpers
========================================================= */

async function getDeployment(deploymentId) {
  const r = await dynamodb.get({
    TableName: "Deployments",
    Key: { deploymentId }
  }).promise();

  return r.Item;
}

async function updateDeployment(deploymentId, data) {
  const updates = [];
  const values = {};
  const names = {};

  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    updates.push(`#${k} = :${k}`);
    values[`:${k}`] = v;
    names[`#${k}`] = k;
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

async function getCrumb() {
  const r = await axios.get(
    `${JENKINS_URL}/crumbIssuer/api/json`,
    { auth }
  );

  return {
    [r.data.crumbRequestField]: r.data.crumb
  };
}

/* =========================================================
   Route
   POST /stop
========================================================= */

router.post("/stop", async (req, res) => {
  const { deploymentId } = req.body;

  if (!deploymentId) {
    return res.status(400).json({
      error: "deploymentId required"
    });
  }

  try {
    /* ===== 1. Get deployment ===== */

    const dep = await getDeployment(deploymentId);

    if (!dep) {
      return res.status(404).json({
        error: "Deployment not found"
      });
    }

    /* ===== 2. Validate state ===== */

    if (dep.status !== "DEPLOYING") {
      return res.json({
        status: "NOT_RUNNING",
        message: "Deployment is not in progress"
      });
    }

    const jobName = dep.deployJobName;
    const buildNumber = dep.deployBuildNumber;

    if (!buildNumber || buildNumber === "NA") {
      return res.json({
        status: "NOT_STARTED"
      });
    }

    /* ===== 3. Stop Jenkins build ===== */

    const crumbHeader = await getCrumb();

    try {
      await axios.post(
        `${JENKINS_URL}/job/${jobName}/${buildNumber}/stop`,
        {},
        { auth, headers: crumbHeader }
      );
    } catch (e) {
      console.warn("Stop request returned error, ignoring:", e.response?.status);
    }

    /* ===== 4. Update deployment ===== */

    await updateDeployment(deploymentId, {
      status: "FAILED",
      completedAt: new Date().toISOString()
    });

    /* ===== 5. Response ===== */

    res.json({
      deploymentId,
      jobName,
      buildNumber,
      status: "STOPPED"
    });

  } catch (err) {
    console.error("Stop error:", err.message);

    res.status(500).json({
      error: "Failed to stop deployment"
    });
  }
});

module.exports = router;
