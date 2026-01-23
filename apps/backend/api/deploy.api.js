const router = require("express").Router();
const axios = require("axios");
const AWS = require("aws-sdk");
const { watchDeployment } = require("../workers/deploymentWatcher");

const {
  JENKINS_URL,
  JENKINS_USER,
  JENKINS_API_TOKEN,
  AWS_REGION
} = process.env;

const auth = { username: JENKINS_USER, password: JENKINS_API_TOKEN };

AWS.config.update({ region: AWS_REGION || "us-east-1" });
const dynamodb = new AWS.DynamoDB.DocumentClient();

/* ================= SAFE UPDATE ================= */

async function updateDeploymentRuntime(deploymentId, data) {
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

/* ================= HELPERS ================= */

async function getApplication(appId) {
  const r = await dynamodb.get({
    TableName: "Applications",
    Key: { appId }
  }).promise();
  return r.Item;
}

async function getBuildNumberFromQueue(queueUrl) {
  while (true) {
    const r = await axios.get(`${queueUrl}api/json`, { auth });
    if (r.data.executable?.number) return r.data.executable.number;
    await new Promise(r => setTimeout(r, 1000));
  }
}

/* ================= ROUTE ================= */

router.post("/deploy", async (req, res) => {
  try {
    const { appId } = req.body;
    if (!appId) return res.status(400).json({ error: "appId required" });

    const app = await getApplication(appId);
    if (!app) return res.status(404).json({ error: "App not found" });

    const { deployJobName: deployJob, destroyJobName: destroyJob } = app;

    const trigger = await axios.post(
      `${JENKINS_URL}/job/${deployJob}/build`,
      {},
      { auth }
    );

    const buildNumber = await getBuildNumberFromQueue(trigger.headers.location);

    const deploymentId = `dep-${Date.now()}`;

    await dynamodb.put({
      TableName: "Deployments",
      Item: {
        deploymentId,
        appId,
        deployJob,
        destroyJob,
        buildNumber,
        status: "RUNNING",
        createdAt: new Date().toISOString()
      }
    }).promise();

    watchDeployment({
      deploymentId,
      jobName: deployJob,
      buildNumber,
      updateDeployment: updateDeploymentRuntime
    });

    // ❗ Auto-destroy is handled ONLY by autoDestroyWorker (not here)

    res.json({ deploymentId, deployJob, destroyJob, buildNumber });

  } catch (err) {
    console.error("Deploy failed:", err.message);
    res.status(500).json({ error: "Deploy failed" });
  }
});

module.exports = router;
