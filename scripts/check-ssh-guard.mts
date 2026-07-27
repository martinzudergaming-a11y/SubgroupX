import assert from "node:assert/strict";
import { isInternalIp } from "../server/src/runtime/ssh-guard.ts";

const INTERNAL = [
  "127.0.0.1", "127.5.5.5", "0.0.0.0", "10.0.0.1", "10.255.255.255",
  "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
  "100.64.0.1", "100.127.0.0", "224.0.0.1", "240.0.0.1", "255.255.255.255",
  "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1",
  "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254",
  "not-an-ip", "", "999.1.1.1",
];
const PUBLIC = [
  "8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.0.1", "172.32.0.1",
  "192.167.0.1", "192.169.0.1", "100.63.0.1", "100.128.0.1", "223.255.255.255",
  "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8",
];

let failed = 0;
for (const ip of INTERNAL) {
  try {
    assert.equal(isInternalIp(ip), true, `${ip} should be INTERNAL/reserved (rejected)`);
    console.log(`  ✓ reject ${ip}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${e instanceof Error ? e.message : e}`);
  }
}
for (const ip of PUBLIC) {
  try {
    assert.equal(isInternalIp(ip), false, `${ip} should be PUBLIC (allowed)`);
    console.log(`  ✓ allow  ${ip}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${e instanceof Error ? e.message : e}`);
  }
}
if (failed) {
  console.error(`\n${failed} ssh-guard checks FAILED`);
  process.exit(1);
}
console.log(`\nall ${INTERNAL.length + PUBLIC.length} ssh-guard checks passed`);
