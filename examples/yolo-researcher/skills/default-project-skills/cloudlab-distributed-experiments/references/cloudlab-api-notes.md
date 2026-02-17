# CloudLab API Notes (validated 2026-02-16)

## Primary Sources
- CloudLab Portal API README: https://gitlab.flux.utah.edu/emulab/portal-api/-/raw/master/README.md
- CloudLab Portal API OpenAPI spec: https://gitlab.flux.utah.edu/emulab/portal-api/-/raw/master/openapi.json
- CloudLab manual (entry): https://docs.cloudlab.us/
- CloudLab repeatable research chapter: https://docs.cloudlab.us/repeatable-research.html
- CloudLab reservations chapter: https://docs.cloudlab.us/reservations.html
- CloudLab creating profiles chapter: https://docs.cloudlab.us/creating-profiles.html
- CloudLab users chapter (SSH setup): https://docs.cloudlab.us/users.html

## Verified API Mechanics
1. Auth headers and environment:
- API calls use header `X-Api-Token`.
- Common env convention in official examples: `PORTAL_TOKEN`, `PORTAL_HTTP`.

2. Experiment lifecycle endpoints:
- `POST /experiments` create
- `GET /experiments/{experiment_id}` status/details
- `PATCH|PUT /experiments/{experiment_id}` modify
- `DELETE /experiments/{experiment_id}` terminate
- `GET /experiments/{experiment_id}/manifests`

3. Node action endpoints:
- Per-node: `/experiments/{experiment_id}/node/{client_id}/reboot|reload|powercycle|start|stop`
- All nodes: `/experiments/{experiment_id}/nodes/reboot|reload|powercycle|start|stop`

4. Snapshot endpoints:
- `POST /experiments/{experiment_id}/snapshot/{client_id}` start snapshot
- `GET /experiments/{experiment_id}/snapshot/{snapshot_id}` poll status

5. Reservation/profile endpoints relevant to future extension:
- Reservations: `/resgroups`, `/resgroups/search`, `/resgroups/{resgroup_id}`
- Profiles: `/profiles`, `/profiles/{profile_id}`
 - Experiment extension: `PUT /experiments/{experiment_id}` with `ExtensionRequest`

## Schema Facts Used By This Skill
1. `ExperimentCreate` required fields (from OpenAPI):
- `name`
- `project`
- `profile_name`
- `profile_project`

2. `ExperimentCreate` useful optional fields:
- `bindings` (JSON object)
- `duration`
- `group`
- `start_at`, `stop_at`
- `paramset_name`, `paramset_owner`

3. Node inventory fields (from `AggregateNode` schema):
- `client_id`
- `hostname`
- `ipv4`
- `status`
- `state`
- `rawstate`

This is why `experiment-hosts` extracts host data from `.aggregates[].nodes[]`.

4. Reservation search/create query params:
- `POST /resgroups/search` requires query `duration` (hours).
- `POST /resgroups` accepts optional query `duration` and `noautoapprove`.

5. Profile update semantics:
- `PATCH /profiles/{profile_id}` for modifying script/public/project_writable.
- `PUT /profiles/{profile_id}` to trigger refresh on repo-backed profiles.
- `GET /profiles/{profile_id}` for inspection and version tracking.
- `DELETE /profiles/{profile_id}` for cleanup.

6. Reservation modify/delete semantics:
- `PUT /resgroups/{resgroup_id}` supports request body updates plus optional query `duration` and `noautoapprove`.
- `GET /resgroups/{resgroup_id}` supports `X-Api-Elaborate` for detailed view.
- `DELETE /resgroups/{resgroup_id}` returns `204` on success.

## Design Rationale
1. Prefer direct `curl + jq` over dependency on `portal-cli` binary:
- Fewer install assumptions for agent runtime.
- Endpoint behavior remains explicit and auditable.

2. Emit unified machine output (`AF_RESULT_JSON`):
- Coordinator can branch automatically based on `status`, `exit_code`, and script-specific fields.
- Failure modes still return structured metadata for retry/escalation.

3. Keep reproducibility tight:
- Explicit `experiment-create` payload parameters.
- Poll-until-ready gate before distributed execution.
- Per-host logs and status files for command fan-out.
- Explicit artifact collection and teardown scripts.

## Known Limits / Future Additions
1. Current host extraction reads aggregate node list and does not parse XML manifests.
2. Reservation-group automation is not included yet; add `resgroup-search/create` scripts if scheduling pressure becomes frequent.
3. Profile create/update automation is not included yet; this skill currently assumes profile already exists.
