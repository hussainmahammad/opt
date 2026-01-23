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
const sts = new AWS.STS();

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function assumeC() {
  const r = await sts.assumeRole({
    RoleArn: ACCOUNT_C_ROLE_ARN,
    RoleSessionName: "deployment-watcher"
  }).promise();

  return new AWS.EC2({
    region: AWS_REGION,
    accessKeyId: r.Credentials.AccessKeyId,
    secretAccessKey: r.Credentials.SecretAccessKey,
    sessionToken: r.Credentials.SessionToken
  });
}

/* ---------- robust instance lookup ---------- */

async function findInstance(ec2, retries = 36) { // 36 × 10s = 6 minutes
  for (let i = 0; i < retries; i++) {
    const r = await ec2.describeInstances({
      Filters: [
        { Name: "tag:Name", Values: ["petcart-shop"] },
        { Name: "instance-state-name", Values: ["pending", "running"] }
      ]
    }).promise();

    const inst = r.Reservations?.[0]?.Instances?.[0];
    if (inst && inst.InstanceId && inst.PrivateDnsName) return inst;

    console.log("Instance not ready yet, retrying...");
    await wait(10000);
  }
  return null;
}

/* ---------- WATCHER ---------- */

async function watchDeployment({ deploymentId, jobName, buildNumber, updateDeployment }) {
  console.log("Watcher started for", deploymentId);

  while (true) {
    try {
      const b = await axios.get(
        `${JENKINS_URL}/job/${jobName}/${buildNumber}/api/json`,
        { auth }
      );

      if (!b.data.building) {
        const status = b.data.result || "FAILED";

        let instanceData = {};

        try {
          const ec2 = await assumeC();
          const inst = await findInstance(ec2);

          if (inst) {
            if (inst.PublicIpAddress) instanceData.publicIp = inst.PublicIpAddress;
            if (inst.InstanceId) instanceData.instanceId = inst.InstanceId;
            if (inst.PrivateDnsName) instanceData.host = inst.PrivateDnsName;

            instanceData.accessLogGroup = "/petcart/nginx/access";
            instanceData.errorLogGroup = "/petcart/nginx/error";
          } else {
            console.error("Instance not found after waiting 6 minutes");
          }

        } catch (e) {
          console.error("EC2 lookup failed:", e.message);
        }

        const payload = {
          status,
          completedAt: new Date().toISOString(),
          ...instanceData
        };

        console.log("Watcher updating:", payload);

        await updateDeployment(deploymentId, payload);
        break;
      }

    } catch (err) {
      console.error("Watcher error:", err.message);
    }

    await wait(10000);
  }
}

module.exports = { watchDeployment };
