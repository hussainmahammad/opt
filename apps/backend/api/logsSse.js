const router = require("express").Router();
const axios = require("axios");
const AWS = require("aws-sdk");

const {
  JENKINS_URL,
  JENKINS_USER,
  JENKINS_API_TOKEN,
  AWS_REGION,
  ACCOUNT_C_ROLE_ARN
} = process.env;

const auth = { username: JENKINS_USER, password: JENKINS_API_TOKEN };

AWS.config.update({ region: AWS_REGION || "us-east-1" });

const dynamodb = new AWS.DynamoDB.DocumentClient();
const sts = new AWS.STS();

/* ================= SSE HEADERS ================= */

function setSseHeaders(res) {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  });
  res.flushHeaders();
}

/* ================= HELPERS ================= */

async function assumeAccountCLogs() {
  const r = await sts.assumeRole({
    RoleArn: ACCOUNT_C_ROLE_ARN,
    RoleSessionName: "sse-app-logs"
  }).promise();

  return new AWS.CloudWatchLogs({
    region: AWS_REGION,
    accessKeyId: r.Credentials.AccessKeyId,
    secretAccessKey: r.Credentials.SecretAccessKey,
    sessionToken: r.Credentials.SessionToken
  });
}

async function getDeployment(deploymentId) {
  const res = await dynamodb.get({
    TableName: "Deployments",
    Key: { deploymentId }
  }).promise();

  return res.Item || null;
}

/* ================= STREAMERS ================= */

async function streamJenkinsLogs({ res, jobName, jobType }) {
  let offset = 0;
  let stopped = false;

  const jobInfo = await axios.get(`${JENKINS_URL}/job/${jobName}/api/json`, { auth });
  const last = jobInfo.data.lastBuild;
  const lastCompleted = jobInfo.data.lastCompletedBuild;

  if (!last || !lastCompleted || last.number === lastCompleted.number) {
    res.write(`event: idle\ndata: No active pipeline\n\n`);
    return;
  }

  const buildNumber = last.number;

  const interval = setInterval(async () => {
    if (stopped) return;

    try {
      const r = await axios.get(
        `${JENKINS_URL}/job/${jobName}/${buildNumber}/logText/progressiveText?start=${offset}`,
        { auth }
      );

      const text = r.data || "";
      const nextOffset = Number(r.headers["x-text-size"] || offset);
      const complete = r.headers["x-more-data"] !== "true";

      if (text) {
        res.write(`event: ${jobType}\ndata: ${text.replace(/\n/g, "\ndata: ")}\n\n`);
      }

      offset = nextOffset;

      if (complete) {
        res.write(`event: complete\ndata: Pipeline finished\n\n`);
        clearInterval(interval);
      }

    } catch (err) {
      res.write(`event: error\ndata: Jenkins error: ${err.message}\n\n`);
    }

  }, 3000);

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

async function streamAppLogs({ res, deployment }) {
  let stopped = false;

  const logs = await assumeAccountCLogs();
  let startTime = Date.now() - 5 * 60 * 1000;

  const interval = setInterval(async () => {
    if (stopped) return;

    try {
      for (const [type, logGroupName] of [
        ["access", deployment.accessLogGroup],
        ["error", deployment.errorLogGroup]
      ]) {
        if (!logGroupName) continue;

        const result = await logs.filterLogEvents({
          logGroupName,
          startTime,
          limit: 50
        }).promise();

        for (const e of result.events || []) {
          res.write(`event: ${type}\ndata: ${e.message.replace(/\n/g, " ")}\n\n`);
          startTime = Math.max(startTime, e.timestamp + 1);
        }
      }

    } catch (err) {
      res.write(`event: error\ndata: App logs error: ${err.message}\n\n`);
    }

  }, 4000);

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

/* ================= ROUTE ================= */

router.get("/logs/stream", async (req, res) => {
  const { deploymentId } = req.query;

  if (!deploymentId) {
    return res.status(400).json({ error: "deploymentId is required" });
  }

  setSseHeaders(res);

  let stopCurrent = null;
  let currentMode = null;

  const loop = setInterval(async () => {
    try {
      const deployment = await getDeployment(deploymentId);

      if (!deployment) {
        res.write(`event: error\ndata: Deployment not found\n\n`);
        return;
      }

      let nextMode = null;
      let starter = null;

      if (deployment.status === "RUNNING") {
        nextMode = "deploy";
        starter = () => streamJenkinsLogs({ res, jobName: deployment.deployJob, jobType: "deploy" });
      } else if (deployment.status === "DESTROYING") {
        nextMode = "destroy";
        starter = () => streamJenkinsLogs({ res, jobName: deployment.destroyJob, jobType: "destroy" });
      } else if (deployment.status === "SUCCESS") {
        nextMode = "runtime";
        starter = () => streamAppLogs({ res, deployment });
      }

      if (nextMode !== currentMode) {
        if (stopCurrent) stopCurrent();
        currentMode = nextMode;
        stopCurrent = starter ? await starter() : null;
      }

    } catch (err) {
      res.write(`event: error\ndata: ${err.message}\n\n`);
    }
  }, 3000);

  req.on("close", () => {
    clearInterval(loop);
    if (stopCurrent) stopCurrent();
    res.end();
  });
});

module.exports = router;
