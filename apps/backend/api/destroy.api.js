const router = require("express").Router();
const axios = require("axios");
const AWS = require("aws-sdk");

const { JENKINS_URL, JENKINS_USER, JENKINS_API_TOKEN, AWS_REGION } = process.env;
const auth = { username: JENKINS_USER, password: JENKINS_API_TOKEN };

AWS.config.update({ region: AWS_REGION || "us-east-1" });
const dynamodb = new AWS.DynamoDB.DocumentClient();

/* ---------- helpers ---------- */

async function getLatestDeployment(appId) {
  const r = await dynamodb.scan({
    TableName: "Deployments",
    FilterExpression: "appId = :a",
    ExpressionAttributeValues: { ":a": appId }
  }).promise();

  if (!r.Items || r.Items.length === 0) return null;

  return r.Items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
}

async function updateStatus(deploymentId, status, destroyed = false) {
  const update = ["#s = :s"];
  const values = { ":s": status };
  const names = { "#s": "status" };

  if (destroyed) {
    update.push("destroyedAt = :t");
    values[":t"] = new Date().toISOString();
  }

  await dynamodb.update({
    TableName: "Deployments",
    Key: { deploymentId },
    UpdateExpression: "SET " + update.join(", "),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values
  }).promise();
}

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function watchDestroy({ jobName, buildNumber, deploymentId }) {
  while (true) {
    const r = await axios.get(
      `${JENKINS_URL}/job/${jobName}/${buildNumber}/api/json`,
      { auth }
    );

    if (!r.data.building) {
      const finalStatus = r.data.result === "SUCCESS" ? "DESTROYED" : "FAILED";
      await updateStatus(deploymentId, finalStatus, true);
      break;
    }

    await wait(5000);
  }
}

/* ---------- route ---------- */

router.post("/destroy", async (req, res) => {
  try {
    const { appId } = req.body;
    if (!appId) return res.status(400).json({ error: "appId required" });

    const dep = await getLatestDeployment(appId);
    if (!dep) return res.status(404).json({ error: "No deployment found" });

    if (dep.status === "DESTROYED" || dep.destroyedAt) {
      return res.json({ status: "ALREADY_DESTROYED" });
    }

    const trigger = await axios.post(
      `${JENKINS_URL}/job/${dep.destroyJob}/build`,
      {},
      { auth }
    );

    const queueUrl = trigger.headers.location;

    let buildNumber;
    while (!buildNumber) {
      const q = await axios.get(`${queueUrl}api/json`, { auth });
      buildNumber = q.data.executable?.number;
      if (!buildNumber) await wait(1000);
    }

    await updateStatus(dep.deploymentId, "DESTROYING");

    watchDestroy({
      jobName: dep.destroyJob,
      buildNumber,
      deploymentId: dep.deploymentId
    });

    res.json({ status: "DESTROYING" });

  } catch (err) {
    console.error("Destroy error:", err.message);
    res.status(500).json({ error: "Failed to destroy" });
  }
});

module.exports = router;
