const AWS = require("aws-sdk");
const axios = require("axios");

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
   CONFIG
========================================================= */

const AUTO_DESTROY_AFTER_MS = 30 * 60 * 1000; // 30 min
const CHECK_INTERVAL_MS = 60 * 1000;

/* =========================================================
   Helpers
========================================================= */

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function getBuildNumberFromQueue(queueUrl) {
  while (true) {
    const q = await axios.get(`${queueUrl}api/json`, { auth });
    if (q.data.executable?.number) return q.data.executable.number;
    await wait(1000);
  }
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

async function watchDestroy({ jobName, buildNumber, deploymentId }) {
  while (true) {
    try {
      const r = await axios.get(
        `${JENKINS_URL}/job/${jobName}/${buildNumber}/api/json`,
        { auth }
      );

      if (!r.data.building) {
        const success = r.data.result === "SUCCESS";

        await updateDeployment(deploymentId, {
          status: success ? "DESTROYED" : "FAILED",
          destroyedAt: success ? new Date().toISOString() : "NA"
        });

        break;
      }
    } catch (err) {
      console.error("Destroy watcher error:", err.message);
    }

    await wait(5000);
  }
}

/* =========================================================
   Scan logic
========================================================= */

async function scanEligibleDeployments() {
  const now = Date.now();

  const res = await dynamodb.scan({
    TableName: "Deployments",
    FilterExpression: "#s = :running",
    ExpressionAttributeNames: {
      "#s": "status"
    },
    ExpressionAttributeValues: {
      ":running": "RUNNING"
    }
  }).promise();

  for (const dep of res.Items || []) {
    if (!dep.completedAt || dep.completedAt === "NA") continue;
    if (dep.destroyedAt && dep.destroyedAt !== "NA") continue;

    const completedTime = new Date(dep.completedAt).getTime();
    if (isNaN(completedTime)) continue;

    if (now - completedTime < AUTO_DESTROY_AFTER_MS) continue;

    console.log("⏳ Auto-destroy:", dep.deploymentId);

    try {
      const trigger = await axios.post(
        `${JENKINS_URL}/job/${dep.destroyJobName}/buildWithParameters`,
        null,
        {
          auth,
          params: {
            DESTROY_TARGET: dep.runtime
          }
        }
      );

      const buildNumber = await getBuildNumberFromQueue(
        trigger.headers.location
      );

      await updateDeployment(dep.deploymentId, {
        status: "DESTROYING",
        destroyBuildNumber: buildNumber
      });

      watchDestroy({
        jobName: dep.destroyJobName,
        buildNumber,
        deploymentId: dep.deploymentId
      });

    } catch (err) {
      console.error("❌ Auto-destroy failed:", err.message);
    }
  }
}

/* =========================================================
   Starter
========================================================= */

function startAutoDestroyWorker() {
  console.log("🚀 Auto-destroy worker started");

  setInterval(() => {
    scanEligibleDeployments().catch(err =>
      console.error("Scan error:", err.message)
    );
  }, CHECK_INTERVAL_MS);
}

module.exports = startAutoDestroyWorker;
