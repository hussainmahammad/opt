const router = require("express").Router();
const AWS = require("aws-sdk");

const { AWS_REGION, ACCOUNT_C_ROLE_ARN } = process.env;

AWS.config.update({ region: AWS_REGION || "us-east-1" });

const dynamodb = new AWS.DynamoDB.DocumentClient();
const sts = new AWS.STS();

/* ---------- helpers ---------- */

async function assumeAccountC() {
  const r = await sts.assumeRole({
    RoleArn: ACCOUNT_C_ROLE_ARN,
    RoleSessionName: "backend-metrics"
  }).promise();

  return new AWS.CloudWatch({
    region: AWS_REGION,
    accessKeyId: r.Credentials.AccessKeyId,
    secretAccessKey: r.Credentials.SecretAccessKey,
    sessionToken: r.Credentials.SessionToken
  });
}

async function getLatestDeployment(appId) {
  const r = await dynamodb.scan({
    TableName: "Deployments",
    FilterExpression: "appId = :a",
    ExpressionAttributeValues: { ":a": appId }
  }).promise();

  if (!r.Items || r.Items.length === 0) return null;

  return r.Items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
}

/* ---------- route ---------- */

router.get("/metrics/:appId", async (req, res) => {
  try {
    const { appId } = req.params;

    const dep = await getLatestDeployment(appId);
    if (!dep) return res.status(404).json({ error: "No deployment found for app" });

    const { instanceId, host, createdAt } = dep;
    if (!instanceId || !host || !createdAt) {
      return res.status(400).json({ error: "Deployment missing instance data" });
    }

    const cloudwatch = await assumeAccountC();

    // normalize createdAt (string or number)
    const deployTime = typeof createdAt === "number"
      ? createdAt
      : new Date(createdAt).getTime();

    if (isNaN(deployTime)) {
      return res.status(400).json({ error: "Invalid createdAt timestamp" });
    }

    const FIVE_MIN = 5 * 60 * 1000;

    const buckets = [];
    for (let i = 1; i <= 6; i++) {
      buckets.push(deployTime + i * FIVE_MIN);
    }

    const m = await cloudwatch.getMetricData({
      StartTime: new Date(deployTime),
      EndTime: new Date(deployTime + 6 * FIVE_MIN),
      MetricDataQueries: [
        {
          Id: "cpu",
          MetricStat: {
            Metric: {
              Namespace: "AWS/EC2",
              MetricName: "CPUUtilization",
              Dimensions: [{ Name: "InstanceId", Value: instanceId }]
            },
            Period: 300,
            Stat: "Average"
          }
        },
        {
          Id: "mem",
          MetricStat: {
            Metric: {
              Namespace: "CWAgent",
              MetricName: "mem_used_percent",
              Dimensions: [{ Name: "host", Value: host }]
            },
            Period: 300,
            Stat: "Average"
          }
        }
      ]
    }).promise();

    function bucketizeGrowing(result) {
      if (!result || !result.Timestamps) return [];

      const pairs = result.Timestamps.map((t, i) => ({
        t: new Date(t).getTime(),
        v: Number(result.Values[i].toFixed(2))
      }));

      pairs.sort((a, b) => a.t - b.t);

      const out = [];

      for (let b = 0; b < buckets.length; b++) {
        const start = buckets[b] - FIVE_MIN;
        const end = buckets[b];

        const found = pairs.find(p => p.t >= start && p.t < end);
        if (found) out.push(found.v);
        else break;
      }

      return out;
    }

    const cpuResult = m.MetricDataResults.find(x => x.Id === "cpu");
    const memResult = m.MetricDataResults.find(x => x.Id === "mem");

    res.json({
      cpu: bucketizeGrowing(cpuResult),
      memory: bucketizeGrowing(memResult)
    });

  } catch (err) {
    console.error("Metrics error:", err.message);
    res.status(500).json({ error: "Failed to fetch metrics" });
  }
});

module.exports = router;
