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

const auth = {
  username: JENKINS_USER,
  password: JENKINS_API_TOKEN
};

AWS.config.update({ region: AWS_REGION || "us-east-1" });

const dynamodb = new AWS.DynamoDB.DocumentClient();
const sts = new AWS.STS();

/* ================= SSE ================= */

function setSseHeaders(res) {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
  res.flushHeaders();
}

/* ================= HELPERS ================= */

async function assumeLogs() {
  const r = await sts.assumeRole({
    RoleArn: ACCOUNT_C_ROLE_ARN,
    RoleSessionName: "logs-sse"
  }).promise();

  return new AWS.CloudWatchLogs({
    region: AWS_REGION,
    accessKeyId: r.Credentials.AccessKeyId,
    secretAccessKey: r.Credentials.SecretAccessKey,
    sessionToken: r.Credentials.SessionToken
  });
}

async function getDeployment(deploymentId) {
  const r = await dynamodb.get({
    TableName: "Deployments",
    Key: { deploymentId }
  }).promise();
  return r.Item;
}

/* ================= JENKINS STREAM ================= */

async function streamJenkins({ res, jobName, buildNumber, eventName }) {
  let offset = 0;
  let stopped = false;

  const interval = setInterval(async () => {
    if (stopped) return;

    try {
      const r = await axios.get(
        `${JENKINS_URL}/job/${jobName}/${buildNumber}/logText/progressiveText?start=${offset}`,
        { auth }
      );

      const text = r.data || "";
      offset = Number(r.headers["x-text-size"] || offset);
      const complete = r.headers["x-more-data"] !== "true";

      if (text) {
        res.write(`event: ${eventName}\ndata: ${text.replace(/\n/g, "\ndata: ")}\n\n`);
      }

      if (complete) {
        res.write(`event: ${eventName}-complete\ndata: finished\n\n`);
        clearInterval(interval);
      }

    } catch (e) {
      res.write(`event: error\ndata: Jenkins error ${e.message}\n\n`);
    }
  }, 3000);

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

/* ================= CLOUDWATCH HELPERS ================= */

async function getLatestStream(logs, logGroupName) {
  const data = await logs.describeLogStreams({
    logGroupName,
    orderBy: "LastEventTime",
    descending: true,
    limit: 1
  }).promise();

  if (!data.logStreams.length) return null;
  return data.logStreams[0].logStreamName;
}

/* ================= EC2 STREAM ================= */

async function streamEc2Logs({ res, logs, accessGroup, errorGroup }) {
  let stopped = false;
  let startTime = Date.now() - 5 * 60 * 1000;

  const interval = setInterval(async () => {
    if (stopped) return;

    try {
      for (const [eventName, group] of [
        ["access", accessGroup],
        ["error", errorGroup]
      ]) {
        if (!group || group === "NA") continue;

        const r = await logs.filterLogEvents({
          logGroupName: group,
          startTime,
          limit: 50
        }).promise();

        for (const e of r.events || []) {
          res.write(`event: ${eventName}\ndata: ${e.message}\n\n`);
          startTime = Math.max(startTime, e.timestamp + 1);
        }
      }
    } catch (e) {
      res.write(`event: error\ndata: EC2 logs error ${e.message}\n\n`);
    }
  }, 4000);

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

/* ================= EKS STREAM ================= */
/* FINAL WORKING FIX */

async function streamEksLogs({ res, logs, logGroup }) {
  let stopped = false;

  const streamName = await getLatestStream(logs, logGroup);
  if (!streamName) return () => {};

  let nextToken = null;

  const interval = setInterval(async () => {
    if (stopped) return;

    try {
      const params = {
        logGroupName: logGroup,
        logStreamName: streamName,
        startFromHead: false
      };

      if (nextToken) params.nextToken = nextToken;

      const data = await logs.getLogEvents(params).promise();
      nextToken = data.nextForwardToken;

      for (const e of data.events) {
        let message = e.message;

        // Extract nginx log from EKS JSON
        try {
          const parsed = JSON.parse(e.message);
          if (parsed.log) {
            message = parsed.log;
          }
        } catch {}

        message = message
          .replace(/\r/g, "")
          .replace(/\n/g, "")
          .trim();

        // IMPORTANT: embed prefix so frontend coloring works
        res.write(`event: access\ndata: event: access ${message}\n\n`);
      }

    } catch (e) {
      res.write(`event: error\ndata: EKS logs error ${e.message}\n\n`);
    }
  }, 4000);

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

/* ================= MAIN ROUTE ================= */

router.get("/logs/stream", async (req, res) => {
  const { deploymentId } = req.query;

  if (!deploymentId) {
    return res.status(400).json({ error: "deploymentId required" });
  }

  setSseHeaders(res);

  let stopCurrent = null;
  let currentMode = null;
  const logsClient = await assumeLogs();

  const loop = setInterval(async () => {
    try {
      const dep = await getDeployment(deploymentId);
      if (!dep) return;

      let nextMode = null;
      let starter = null;

      if (dep.status === "DEPLOYING" && dep.deployBuildNumber !== "NA") {
        nextMode = "deploy";
        starter = () =>
          streamJenkins({
            res,
            jobName: dep.deployJobName,
            buildNumber: dep.deployBuildNumber,
            eventName: "deploy"
          });
      }

      else if (dep.status === "DESTROYING" && dep.destroyBuildNumber !== "NA") {
        nextMode = "destroy";
        starter = () =>
          streamJenkins({
            res,
            jobName: dep.destroyJobName,
            buildNumber: dep.destroyBuildNumber,
            eventName: "destroy"
          });
      }

      else if (dep.status === "RUNNING") {
        if (dep.runtime === "ec2") {
          nextMode = "ec2";
          starter = () =>
            streamEc2Logs({
              res,
              logs: logsClient,
              accessGroup: dep.logGroupAccess,
              errorGroup: dep.logGroupError
            });
        }

        else if (dep.runtime === "eks-fargate" || dep.runtime === "eks-ec2") {
          nextMode = "eks";
          starter = () =>
            streamEksLogs({
              res,
              logs: logsClient,
              logGroup: dep.logGroup
            });
        }
      }

      if (nextMode !== currentMode) {
        if (stopCurrent) stopCurrent();
        currentMode = nextMode;
        if (starter) stopCurrent = await starter();
      }

    } catch (e) {
      res.write(`event: error\ndata: ${e.message}\n\n`);
    }
  }, 3000);

  req.on("close", () => {
    clearInterval(loop);
    if (stopCurrent) stopCurrent();
    res.end();
  });
});

module.exports = router;
