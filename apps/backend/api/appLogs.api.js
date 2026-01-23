const router = require("express").Router();
const AWS = require("aws-sdk");

const {
  AWS_REGION,
  ACCOUNT_C_ROLE_ARN
} = process.env;

AWS.config.update({ region: AWS_REGION || "us-east-1" });

const dynamodb = new AWS.DynamoDB.DocumentClient();
const sts = new AWS.STS();

/* ================= HELPERS ================= */

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

async function getLatestDeployment(appId) {
  const res = await dynamodb.scan({
    TableName: "Deployments",
    FilterExpression: "appId = :a",
    ExpressionAttributeValues: { ":a": appId }
  }).promise();

  if (!res.Items || res.Items.length === 0) return null;

  return res.Items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
}

/* ================= ROUTE ================= */

router.get("/app-logs/:appId", async (req, res) => {
  const { appId } = req.params;
  const { type } = req.query;

  if (!type || !["access", "error"].includes(type)) {
    return res.status(400).json({ error: "type must be 'access' or 'error'" });
  }

  try {
    const deployment = await getLatestDeployment(appId);

    if (!deployment) {
      return res.status(404).json({ error: "No deployment found for this app" });
    }

    const logGroupName =
      type === "access" ? deployment.accessLogGroup : deployment.errorLogGroup;

    if (!logGroupName) {
      return res.status(404).json({ error: "No log group recorded for this deployment" });
    }

    const logs = await assumeAccountCLogs();

    const result = await logs.filterLogEvents({
      logGroupName,
      limit: 100,
      startTime: Date.now() - 1000 * 60 * 60 // last 1 hour
    }).promise();

    res.json({
      appId,
      type,
      logGroup: logGroupName,
      count: result.events.length,
      events: result.events
    });

  } catch (err) {
    console.error("App logs error:", err.message);
    res.status(500).json({ error: "Failed to fetch app logs" });
  }
});

module.exports = router;
