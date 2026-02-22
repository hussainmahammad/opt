const router = require("express").Router();
const AWS = require("aws-sdk");

const {
  AWS_REGION,
  ACCOUNT_C_ROLE_ARN
} = process.env;

AWS.config.update({ region: AWS_REGION || "us-east-1" });

const dynamodb = new AWS.DynamoDB.DocumentClient();
const sts = new AWS.STS();

/* ================= ASSUME ROLE ================= */

async function assumeAccountCLogs() {
  const r = await sts.assumeRole({
    RoleArn: ACCOUNT_C_ROLE_ARN,
    RoleSessionName: "app-logs-reader"
  }).promise();

  return new AWS.CloudWatchLogs({
    region: AWS_REGION,
    accessKeyId: r.Credentials.AccessKeyId,
    secretAccessKey: r.Credentials.SecretAccessKey,
    sessionToken: r.Credentials.SessionToken
  });
}

/* ================= HELPERS ================= */

async function getDeployment(deploymentId) {
  const res = await dynamodb.get({
    TableName: "Deployments",
    Key: { deploymentId }
  }).promise();

  return res.Item;
}

/* Get latest active stream (for EKS) */
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

/* Stream logs continuously (SSE) */
async function streamLogEvents(res, logs, logGroupName, logStreamName) {
  let nextToken = null;

  const interval = setInterval(async () => {
    try {
      const params = {
        logGroupName,
        logStreamName,
        startFromHead: false
      };

      if (nextToken) params.nextToken = nextToken;

      const data = await logs.getLogEvents(params).promise();

      nextToken = data.nextForwardToken;

      for (const event of data.events) {
        res.write(`data: ${JSON.stringify({
          timestamp: event.timestamp,
          message: event.message
        })}\n\n`);
      }

    } catch (err) {
      console.error("Log streaming error:", err.message);
    }
  }, 3000);

  res.on("close", () => {
    clearInterval(interval);
  });
}

/* ================= ROUTE ================= */
/*
EC2:
GET /app-logs/:deploymentId?type=access|error

EKS:
GET /app-logs/:deploymentId
*/

router.get("/app-logs/:deploymentId", async (req, res) => {
  const { deploymentId } = req.params;
  const { type } = req.query;

  try {
    /* ===== 1. Fetch deployment ===== */

    const deployment = await getDeployment(deploymentId);

    if (!deployment) {
      return res.status(404).json({ error: "Deployment not found" });
    }

    if (deployment.status !== "RUNNING") {
      return res.status(400).json({ error: "Deployment not running" });
    }

    const runtime = deployment.runtime;
    let logGroupName;

    /* ================= EC2 ================= */

    if (runtime === "ec2") {
      if (!type || !["access", "error"].includes(type)) {
        return res.status(400).json({
          error: "For EC2, type=access or error is required"
        });
      }

      logGroupName =
        type === "access"
          ? deployment.logGroupAccess
          : deployment.logGroupError;

      if (!logGroupName || logGroupName === "NA") {
        return res.status(400).json({
          error: "Log group not available for this deployment"
        });
      }
    }

    /* ================= EKS (Fargate / EC2) ================= */

    else if (runtime === "eks-fargate" || runtime === "eks-ec2") {
      logGroupName = deployment.logGroup;

      if (!logGroupName || logGroupName === "NA") {
        return res.status(400).json({
          error: "Log group not available for this deployment"
        });
      }
    }

    else {
      return res.status(400).json({
        error: "Unsupported runtime"
      });
    }

    /* ===== 2. CloudWatch Client ===== */

    const logs = await assumeAccountCLogs();

    /* ===== 3. Determine stream ===== */

    let logStreamName;

    if (runtime === "ec2") {
      // EC2 nginx logs → usually single stream
      const stream = await getLatestStream(logs, logGroupName);
      if (!stream) {
        return res.status(404).json({ error: "No log streams found" });
      }
      logStreamName = stream;
    } else {
      // EKS / Fargate → many pod streams → pick latest
      const stream = await getLatestStream(logs, logGroupName);
      if (!stream) {
        return res.status(404).json({ error: "No active pod streams found" });
      }
      logStreamName = stream;
    }

    /* ===== 4. SSE Headers ===== */

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });

    res.write(`data: ${JSON.stringify({
      message: "Streaming logs",
      deploymentId,
      runtime,
      logGroupName,
      logStreamName
    })}\n\n`);

    /* ===== 5. Start streaming ===== */

    streamLogEvents(res, logs, logGroupName, logStreamName);

  } catch (err) {
    console.error("App logs error:", err.message);
    res.status(500).json({ error: "Failed to fetch logs" });
  }
});

module.exports = router;
