const fs = require('fs');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON;
const siteUrl = process.env.SITE_URL;

const totalRequests = Number(process.env.TOTAL) || 200;
const testHours = Number(process.env.PERIOD_HOURS) || 4;
const timeLimit = 5000;
const retryEvery = 30000;

let requests = [
  { name: 'Read schedules', url: supabaseUrl + '/rest/v1/schedules?select=*&limit=20' },
  { name: 'Read routes', url: supabaseUrl + '/rest/v1/routes?select=*&limit=20' },
  { name: 'Read trains', url: supabaseUrl + '/rest/v1/trains?select=*&limit=20' },
  { name: 'Auth service', url: supabaseUrl + '/auth/v1/health' },
];

if (siteUrl) {
  requests.push({ name: 'Open home page', url: siteUrl });
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendRequest(req) {
  let start = Date.now();
  try {
    let res = await fetch(req.url, {
      headers: { apikey: supabaseKey, Authorization: 'Bearer ' + supabaseKey },
      signal: AbortSignal.timeout(timeLimit)
    });
    let text = await res.text();
    let time = Date.now() - start;

    if (!res.ok) {
      return { ok: false, time: time, reason: 'HTTP ' + res.status };
    }
    if (text.length < 2) {
      return { ok: false, time: time, reason: 'Empty response' };
    }
    return { ok: true, time: time, reason: '' };
  } catch (err) {
    let reason = 'Network error';
    if (err.name === 'TimeoutError') reason = 'Timeout';
    return { ok: false, time: Date.now() - start, reason: reason };
  }
}

async function waitUntilWorking(req) {
  let start = Date.now();
  for (let i = 0; i < 120; i++) {
    await wait(retryEvery);
    let result = await sendRequest(req);
    if (result.ok) break;
  }
  return Date.now() - start;
}

async function main() {
  let results = [];
  let gap = (testHours * 3600000) / totalRequests;
  let testStart = Date.now();

  console.log('Starting test: ' + totalRequests + ' requests in ' + testHours + ' hours');

  for (let i = 1; i <= totalRequests; i++) {
    let req = requests[Math.floor(Math.random() * requests.length)];
    let result = await sendRequest(req);
    let downTime = 0;

    if (result.ok) {
      console.log('#' + i + ' OK - ' + req.name + ' (' + result.time + ' ms)');
    } else {
      downTime = await waitUntilWorking(req);
      console.log('#' + i + ' FAILED - ' + req.name + ' - ' + result.reason +
                  ' - back after ' + (downTime / 60000).toFixed(1) + ' min');
    }

    results.push({
      number: i,
      time: new Date().toISOString(),
      request: req.name,
      ok: result.ok,
      ms: result.time,
      reason: result.reason,
      downTime: downTime
    });

    let nextTime = testStart + i * gap;
    if (nextTime > Date.now()) await wait(nextTime - Date.now());
  }

  // ===== calculations =====
  let totalHours = (Date.now() - testStart) / 3600000;
  let failures = 0;
  let downMs = 0;
  for (let r of results) {
    if (!r.ok) failures++;
    downMs += r.downTime;
  }
  let downHours = downMs / 3600000;
  let upHours = totalHours - downHours;

  let pofod = failures / totalRequests;
  let rocof = failures / totalHours;
  let mtbf = failures > 0 ? upHours / failures : 0;
  let mttr = failures > 0 ? (downMs / 60000) / failures : 0;
  let availability = (upHours / totalHours) * 100;

  let csv = 'number,time,request,ok,ms,reason,down_ms\n';
  for (let r of results) {
    csv += r.number + ',' + r.time + ',' + r.request + ',' + r.ok + ',' + r.ms + ',' + r.reason + ',' + r.downTime + '\n';
  }
  fs.writeFileSync('reliability-log.csv', csv);

  let out = '## Results\n\n';
  out += '| Measure | Value |\n|---|---|\n';
  out += '| Requests | ' + totalRequests + ' |\n';
  out += '| Failures | ' + failures + ' |\n';
  out += '| Test time | ' + totalHours.toFixed(2) + ' hours |\n';
  out += '| Downtime | ' + (downMs / 60000).toFixed(1) + ' min |\n';
  out += '| POFOD | ' + pofod.toFixed(3) + ' |\n';
  out += '| ROCOF | ' + rocof.toFixed(3) + ' failures per hour |\n';
  out += '| MTBF | ' + (failures > 0 ? mtbf.toFixed(2) + ' hours' : 'no failures') + ' |\n';
  out += '| MTTR | ' + mttr.toFixed(1) + ' min |\n';
  out += '| Availability | ' + availability.toFixed(2) + ' % |\n\n';

  out += '## Failures\n\n';
  if (failures === 0) {
    out += 'No failures.\n';
  } else {
    out += '| # | Time | Request | Reason | Down (min) |\n|---|---|---|---|---|\n';
    for (let r of results) {
      if (!r.ok) {
        out += '| ' + r.number + ' | ' + r.time + ' | ' + r.request + ' | ' + r.reason + ' | ' + (r.downTime / 60000).toFixed(1) + ' |\n';
      }
    }
  }

  console.log(out);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, out);
  }
}

main();
