const AWS = require("aws-sdk");
const axios = require("axios");

const {
  JENKINS_URL,
  JENKINS_USER,
  JENKINS_API_TOKEN,
  AWS_REGION
} = process.env;

const auth = { username: JENKINS_USER, password: JENKINS_API_TOKEN };

AWS.config.update({ region: AWS_REGION || "us-east-1" });
const dynamodb = new AWS.DynamoDB.DocumentClient();

/* ===== CONFIG ===== */

const AUTO_DESTROY_AFTER_MS = 30 * 60 * 1000; // 30 min
const CHECK_INTERVAL_MS = 60 * 1000;          // every 1 min

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/* ===== HELPERS ===== */

async function watchDestroy({ jobName, buildNumber, deploymentId }) {
  while (true) {
    const r = await axios.get(
      `${JENKINS_URL}/job/${jobName}/${buildNumber}/api/json`,
      { auth }
    );

    if (!r.data.building) {
      const success = r.data.result === "SUCCESS";
      const finalStatus = success ? "DESTROYED" : "FAILED";

      await dynamodb.update({
        TableName: "Deployments",
        Key: { deploymentId },
        UpdateExpression: "SET #s = :s" + (success ? ", destroyedAt = :t" : ""),
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: success
          ? { ":s": finalStatus, ":t": new Date().toISOString() }
          : { ":s": finalStatus }
      }).promise();

      break;
    }

    await wait(5000);
  }
}

async function getBuildNumberFromQueue(queueUrl) {
  while (true) {
    const q = await axios.get(`${queueUrl}api/json`, { auth });
    if (q.data.executable?.number) return q.data.executable.number;
    await wait(1000);
  }
}

async function scanEligibleDeployments() {
  const now = Date.now();

  const res = await dynamodb.scan({
    TableName: "Deployments",
    FilterExpression: "attribute_exists(completedAt) AND attribute_not_exists(destroyedAt)"
  }).promise();

  for (const dep of res.Items || []) {
    if (!dep.completedAt || !dep.destroyJob) continue;

    const completedTime = new Date(dep.completedAt).getTime();
    if (isNaN(completedTime)) continue;

    if (now - completedTime < AUTO_DESTROY_AFTER_MS) continue;

    console.log("⏳ Auto-destroy triggered for", dep.deploymentId);

    try {
      const trigger = await axios.post(
        `${JENKINS_URL}/job/${dep.destroyJob}/build`,
        {},
        { auth }
      );

      const buildNumber = await getBuildNumberFromQueue(trigger.headers.location);

      await dynamodb.update({
        TableName: "Deployments",
        Key: { deploymentId: dep.deploymentId },
        UpdateExpression: "SET #s = :s",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":s": "DESTROYING" }
      }).promise();

      watchDestroy({
        jobName: dep.destroyJob,
        buildNumber,
        deploymentId: dep.deploymentId
      });

    } catch (err) {
      console.error("❌ Auto-destroy failed:", err.message);
    }
  }
}

/* ===== STARTER ===== */

function startAutoDestroyWorker() {
  console.log("🚀 Auto-destroy worker started");

  setInterval(() => {
    scanEligibleDeployments().catch(err =>
      console.error("❌ Auto-destroy scan error:", err.message)
    );
  }, CHECK_INTERVAL_MS);
}

module.exports = startAutoDestroyWorker;
