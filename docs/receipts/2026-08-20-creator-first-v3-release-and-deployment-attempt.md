# 2026-08-20 creator-first v3 release and deployment attempt

## Evidence level

`LOCAL_RELEASE_VERIFIED / PUBLIC_GITHUB_SYNCED / REMOTE_DEPLOYMENT_NOT_STARTED`

This receipt separates a verified release artifact from an actual cloud deployment. It does not claim that creator-first v3 is installed, active, armed or capable of signing on the production host.

## Verified local release

| Field | Value |
| --- | --- |
| Source commit | `5f61af416b16d525639a50fbabfaa2cd5645c37c` |
| GitHub branch | `agent/keyless-control-production-deployment` |
| Capability manifest | revision `19`, SHA-256 `b2a6238728bb4515af648ad9804bb6895c9cfde973a01205cb1d449133cb3862` |
| Archive | `local-clockin-sniper-0.1.0.tgz` |
| Archive SHA-256 | `2fd82c9fac490d17d80c0b2c2769442363996aa2a3156cf88a1613cc7f3e2dee` |
| BUILD-METADATA SHA-256 | `d72f38a4a0a7ae3c29cd133943d7fde8848357dae8eca26b47c57badb3394882` |
| Archive boundary | passed, `384` files |
| Tests | `393/393` passed |
| Core coverage | lines `89.30%`, branches `68.90%`, functions `88.93%` |
| Production-entrypoint coverage | lines `34.38%`, branches `70.89%`, functions `68.82%` |
| Secret/public gates | repository tree, 580 Git-history text blobs, 251 tracked public files passed |
| Production dependency audit | `0` vulnerabilities at configured high threshold |

Tests, fixtures and archive inspection are release evidence only. They are not a simulated trade or a live execution receipt.

## Remote preflight result

Target: production host `47.251.28.201`, SSH port `2222`.

Read-only network probes produced a consistent host-runtime symptom:

- TCP connection to port `2222` succeeded, but SSH timed out before the server banner;
- TCP connection to port `80` succeeded, but HTTP returned no response bytes before timeout;
- repeated bounded SSH attempts produced the same banner timeout;
- the local Aliyun CLI had no configured control-plane credentials, so Cloud Assistant/instance state could not be queried and no reboot was authorized or attempted.

Because no SSH session was established:

- the archive was not uploaded;
- no release directory, symlink, systemd unit or process was changed;
- no credential was read or copied;
- no authorization or marker was created;
- no paid RPC or signer service was started;
- the last verified production state remains the post-launch revoked state recorded in the missed-launch postmortem.

## Resume boundary

Before deployment resumes, an operator with Aliyun control-plane access must restore normal SSH/HTTP response and confirm the instance is running. A reboot has production impact and requires explicit operator action; it must not be inferred from this receipt.

After the host responds, resume from read-only state verification, verify both approval markers remain absent and all paid units/path remain stopped, then deploy the checksum-bound artifact. Creator-first v3 must still remain unarmed until a new one-shot profile, authorization, current wallet readiness and dual-marker receipt exist.
