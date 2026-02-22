const router = require("express").Router();
const AWS = require("aws-sdk");

const { AWS_REGION, ACCOUNT_C_ROLE_ARN } = process.env;

AWS.config.update({ region: AWS_REGION || "us-east-1" });

const dynamodb = new AWS.DynamoDB.DocumentClient();
const sts = new AWS.STS();

/* =========================================================
   Assume Account C
========================================================= */

async function assumeAccountC() {
  const r = await sts.assumeRole({
    RoleArn: ACCOUNT_C_ROLE_ARN,
    RoleSessionName: "metrics-reader"
  }).promise();

  const creds = {
    accessKeyId: r.Credentials.AccessKeyId,
    secretAccessKey: r.Credentials.SecretAccessKey,
    sessionToken: r.Credentials.SessionToken,
    region: AWS_REGION
  };

  return {
    cloudwatch: new AWS.CloudWatch(creds),
    autoscaling: new AWS.AutoScaling(creds),
    ec2: new AWS.EC2(creds)
  };
}

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

/* =========================================================
   Time Window (Lifecycle: 0 → 30 mins)
========================================================= */

function getLifecycleWindow(dep) {
  if (!dep.completedAt) return null;

  const start = new Date(dep.completedAt);
  const now = new Date();

  const maxEnd = new Date(start.getTime() + 30 * 60 * 1000);
  const end = now < maxEnd ? now : maxEnd;

  if (end <= start) return null;

  return { start, end };
}

/* =========================================================
   CloudWatch Series Helper
========================================================= */

async function getAverageSeries(
  cloudwatch,
  namespace,
  metricName,
  dimensionsList,
  start,
  end
) {
  if (!dimensionsList.length) return { minutes: [], values: [] };

  const queries = dimensionsList.map((dims, i) => ({
    Id: `m${i}`,
    MetricStat: {
      Metric: {
        Namespace: namespace,
        MetricName: metricName,
        Dimensions: dims
      },
      Period: 300,
      Stat: "Average"
    }
  }));

  const r = await cloudwatch.getMetricData({
    StartTime: start,
    EndTime: end,
    MetricDataQueries: queries
  }).promise();

  const bucketMap = {};

  r.MetricDataResults.forEach(m => {
    m.Timestamps.forEach((ts, idx) => {
      const t = new Date(ts).getTime();
      const v = m.Values[idx];

      if (!bucketMap[t]) bucketMap[t] = [];
      bucketMap[t].push(v);
    });
  });

  const sortedTimes = Object.keys(bucketMap)
    .map(Number)
    .sort((a, b) => a - b);

  const baseTime = new Date(start).getTime();

  const minutes = [];
  const values = [];

  sortedTimes.forEach(t => {
    const arr = bucketMap[t];
    const avg = arr.reduce((a, b) => a + b, 0) / arr.length;

    const minute = Math.round((t - baseTime) / 60000);

    minutes.push(minute);
    values.push(Number(avg.toFixed(2)));
  });

  return { minutes, values };
}

/* =========================================================
   EC2 Metrics (unchanged)
========================================================= */

async function getEc2Metrics(dep, clients, start, end) {
  const { cloudwatch, autoscaling, ec2 } = clients;

  if (!dep.asgName || dep.asgName === "NA") {
    return { minutes: [], cpu: [], memory: [], instanceCount: 0 };
  }

  const asg = await autoscaling.describeAutoScalingGroups({
    AutoScalingGroupNames: [dep.asgName]
  }).promise();

  if (!asg.AutoScalingGroups.length) {
    return { minutes: [], cpu: [], memory: [], instanceCount: 0 };
  }

  const instanceIds = asg.AutoScalingGroups[0].Instances
    .filter(i => i.LifecycleState === "InService")
    .map(i => i.InstanceId);

  if (!instanceIds.length) {
    return { minutes: [], cpu: [], memory: [], instanceCount: 0 };
  }

  const ec2Data = await ec2.describeInstances({
    InstanceIds: instanceIds
  }).promise();

  const hosts = [];
  ec2Data.Reservations.forEach(r => {
    r.Instances.forEach(i => {
      if (i.PrivateDnsName) hosts.push(i.PrivateDnsName);
    });
  });

  const cpuSeries = await getAverageSeries(
    cloudwatch,
    "AWS/EC2",
    "CPUUtilization",
    instanceIds.map(id => [{ Name: "InstanceId", Value: id }]),
    start,
    end
  );

  const memSeries = await getAverageSeries(
    cloudwatch,
    "CWAgent",
    "mem_used_percent",
    hosts.map(h => [{ Name: "host", Value: h }]),
    start,
    end
  );

  return {
    minutes: cpuSeries.minutes,
    cpu: cpuSeries.values,
    memory: memSeries.values,
    instanceCount: instanceIds.length
  };
}

/* =========================================================
   EKS-EC2 Metrics (NEW)
========================================================= */

async function getEksMetrics(dep, cloudwatch, start, end) {
  if (
    !dep.clusterName || dep.clusterName === "NA" ||
    !dep.namespace || dep.namespace === "NA" ||
    !dep.deploymentName || dep.deploymentName === "NA"
  ) {
    return { minutes: [], cpu: [], memory: [] };
  }

  const dimensions = [
    {
      Name: "ClusterName",
      Value: dep.clusterName
    },
    {
      Name: "Namespace",
      Value: dep.namespace
    }
  ];

  const cpuSeries = await getAverageSeries(
    cloudwatch,
    "ContainerInsights",
    "pod_cpu_utilization",
    [dimensions],
    start,
    end
  );

  const memSeries = await getAverageSeries(
    cloudwatch,
    "ContainerInsights",
    "pod_memory_utilization",
    [dimensions],
    start,
    end
  );

  return {
    minutes: cpuSeries.minutes,
    cpu: cpuSeries.values,
    memory: memSeries.values
  };
}

/* =========================================================
   Route
========================================================= */

router.get("/metrics/:deploymentId", async (req, res) => {
  try {
    const { deploymentId } = req.params;

    const dep = await getDeployment(deploymentId);

    if (!dep) {
      return res.status(404).json({ error: "Deployment not found" });
    }

    if (!dep.metricsEnabled) {
      return res.json({
        deploymentId,
        metricsEnabled: false
      });
    }

    if (!dep.completedAt) {
      return res.json({
        deploymentId,
        message: "Metrics not available yet"
      });
    }

    const window = getLifecycleWindow(dep);
    if (!window) {
      return res.json({
        deploymentId,
        minutes: [],
        cpu: [],
        memory: []
      });
    }

    const clients = await assumeAccountC();

    /* ===== EC2 ===== */
    if (dep.metricsType === "ec2") {
      const data = await getEc2Metrics(dep, clients, window.start, window.end);

      return res.json({
        deploymentId,
        runtime: dep.runtime,
        metricsType: "ec2",
        ...data
      });
    }

    /* ===== EKS-EC2 ===== */
    if (dep.metricsType === "eks") {
      const data = await getEksMetrics(
        dep,
        clients.cloudwatch,
        window.start,
        window.end
      );

      return res.json({
        deploymentId,
        runtime: dep.runtime,
        metricsType: "eks",
        ...data
      });
    }

    return res.json({
      deploymentId,
      metricsEnabled: false
    });

  } catch (err) {
    console.error("Metrics error:", err.message);
    res.status(500).json({ error: "Failed to fetch metrics" });
  }
});

module.exports = router;
