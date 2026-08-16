import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

import {
  CanonicalInvariantError,
  assertDecimalString,
  canonicalJson,
  type CapitalReservation,
  type EffectRecord,
  type ExecutionPlan,
  type ExitPlan,
  type FactoryProfile,
  type IsoTimestamp,
  type LaunchIdentity,
  type PositionLot,
  type ReservationState,
  type RouteQuote,
  type SignalEvidence,
  type StrategyBudget,
  type TxAttempt,
  type WalletLane,
} from "../core/canonical.js";
import type { FeeBandPlan } from "../entry/fee-band-planner.js";

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: string;
  readonly down: string;
}

const migrations: readonly Migration[] = Object.freeze([
  {
    version: 1,
    name: "canonical_core",
    up: `
      CREATE TABLE factory_profiles (
        profile_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        strategy_id TEXT NOT NULL,
        address TEXT NOT NULL,
        state TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (profile_id, revision)
      );
      CREATE TABLE signal_evidence (
        evidence_id TEXT PRIMARY KEY,
        strategy_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        source_kind TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );
      CREATE TABLE launch_identities (
        launch_id TEXT PRIMARY KEY,
        strategy_id TEXT NOT NULL,
        token_address TEXT NOT NULL,
        pool_address TEXT NOT NULL,
        transaction_hash TEXT NOT NULL,
        log_index TEXT NOT NULL,
        identity_policy_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        frozen_at TEXT NOT NULL,
        UNIQUE (strategy_id, launch_id),
        UNIQUE (strategy_id, transaction_hash, log_index)
      );
      CREATE TABLE strategy_budgets (
        budget_id TEXT PRIMARY KEY,
        strategy_id TEXT NOT NULL,
        launch_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        config_hash TEXT NOT NULL,
        principal_limit TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (strategy_id, launch_id)
      );
      CREATE TABLE wallet_lanes (
        lane_id TEXT PRIMARY KEY,
        strategy_id TEXT NOT NULL,
        launch_id TEXT NOT NULL,
        wallet_id TEXT NOT NULL,
        wallet_address TEXT NOT NULL,
        tranche_number INTEGER NOT NULL CHECK (tranche_number > 0),
        state TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (strategy_id, launch_id, tranche_number),
        UNIQUE (strategy_id, launch_id, wallet_address)
      );
      CREATE TABLE capital_reservations (
        reservation_id TEXT PRIMARY KEY,
        strategy_id TEXT NOT NULL,
        budget_id TEXT NOT NULL REFERENCES strategy_budgets(budget_id),
        launch_id TEXT NOT NULL,
        lane_id TEXT NOT NULL REFERENCES wallet_lanes(lane_id),
        intent_id TEXT NOT NULL,
        config_hash TEXT NOT NULL,
        principal_raw TEXT NOT NULL,
        state TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (strategy_id, launch_id, lane_id),
        UNIQUE (intent_id)
      );
      CREATE TABLE audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        event_kind TEXT NOT NULL,
        strategy_id TEXT NOT NULL,
        launch_id TEXT,
        object_id TEXT NOT NULL,
        parent_event_id TEXT,
        reason_code TEXT,
        payload_json TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );
      CREATE TABLE service_leases (
        resource_key TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        fencing_epoch INTEGER NOT NULL CHECK (fencing_epoch > 0),
        expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
    down: `
      DROP TABLE service_leases;
      DROP TABLE audit_events;
      DROP TABLE capital_reservations;
      DROP TABLE wallet_lanes;
      DROP TABLE strategy_budgets;
      DROP TABLE launch_identities;
      DROP TABLE signal_evidence;
      DROP TABLE factory_profiles;
    `,
  },
  {
    version: 2,
    name: "execution_effects_and_exit",
    up: `
      CREATE TABLE execution_plans (
        plan_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        strategy_id TEXT NOT NULL,
        launch_id TEXT NOT NULL,
        lane_id TEXT NOT NULL REFERENCES wallet_lanes(lane_id),
        wallet_address TEXT NOT NULL,
        nonce TEXT NOT NULL,
        plan_hash TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (plan_id, revision),
        UNIQUE (wallet_address, nonce)
      );
      CREATE TABLE tx_attempts (
        attempt_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        plan_id TEXT NOT NULL,
        strategy_id TEXT NOT NULL,
        launch_id TEXT NOT NULL,
        lane_id TEXT NOT NULL,
        wallet_address TEXT NOT NULL,
        nonce TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (attempt_id, revision),
        UNIQUE (tx_hash)
      );
      CREATE TABLE effect_records (
        effect_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        attempt_id TEXT NOT NULL,
        strategy_id TEXT NOT NULL,
        launch_id TEXT NOT NULL,
        lane_id TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        result TEXT NOT NULL,
        canonicality TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        PRIMARY KEY (effect_id, revision),
        UNIQUE (attempt_id, revision)
      );
      CREATE TABLE position_lots (
        lot_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        strategy_id TEXT NOT NULL,
        launch_id TEXT NOT NULL,
        lane_id TEXT NOT NULL,
        wallet_address TEXT NOT NULL,
        token_address TEXT NOT NULL,
        remaining_raw TEXT NOT NULL,
        state TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (lot_id, revision)
      );
      CREATE TABLE route_quotes (
        quote_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        strategy_id TEXT NOT NULL,
        launch_id TEXT NOT NULL,
        lot_id TEXT NOT NULL,
        route_id TEXT NOT NULL,
        net_output_raw TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        PRIMARY KEY (quote_id, revision)
      );
      CREATE TABLE exit_plans (
        exit_plan_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        strategy_id TEXT NOT NULL,
        launch_id TEXT NOT NULL,
        lot_id TEXT NOT NULL,
        state TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (exit_plan_id, revision)
      );
      CREATE INDEX idx_audit_strategy_launch ON audit_events(strategy_id, launch_id, sequence);
      CREATE INDEX idx_attempt_state ON tx_attempts(state, updated_at);
      CREATE INDEX idx_position_state ON position_lots(strategy_id, launch_id, state);
    `,
    down: `
      DROP INDEX idx_position_state;
      DROP INDEX idx_attempt_state;
      DROP INDEX idx_audit_strategy_launch;
      DROP TABLE exit_plans;
      DROP TABLE route_quotes;
      DROP TABLE position_lots;
      DROP TABLE effect_records;
      DROP TABLE tx_attempts;
      DROP TABLE execution_plans;
    `,
  },
  {
    version: 3,
    name: "persistent_wallet_nonce_ownership",
    up: `
      CREATE TABLE wallet_entry_claims (
        strategy_id TEXT NOT NULL,
        launch_id TEXT NOT NULL,
        wallet_address TEXT NOT NULL,
        intent_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (strategy_id, launch_id, wallet_address)
      );
      CREATE TABLE wallet_nonce_slots (
        wallet_address TEXT NOT NULL,
        nonce TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        fencing_epoch INTEGER NOT NULL CHECK (fencing_epoch > 0),
        purpose TEXT NOT NULL,
        state TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (wallet_address, nonce)
      );
      CREATE INDEX idx_wallet_nonce_state ON wallet_nonce_slots(wallet_address, state);
    `,
    down: `
      DROP INDEX idx_wallet_nonce_state;
      DROP TABLE wallet_nonce_slots;
      DROP TABLE wallet_entry_claims;
    `,
  },
  {
    version: 4,
    name: "versioned_fee_band_plans",
    up: `
      CREATE TABLE fee_band_plans (
        planner_revision TEXT PRIMARY KEY,
        strategy_id TEXT NOT NULL,
        launch_id TEXT NOT NULL,
        mechanism_profile_revision INTEGER NOT NULL CHECK (mechanism_profile_revision > 0),
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (strategy_id, launch_id, mechanism_profile_revision)
      );
    `,
    down: `
      DROP TABLE fee_band_plans;
    `,
  },
  {
    version: 5,
    name: "append_only_execution_revisions",
    up: `
      DROP INDEX idx_attempt_state;
      ALTER TABLE execution_plans RENAME TO execution_plans_v4;
      CREATE TABLE execution_plans (
        plan_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        strategy_id TEXT NOT NULL,
        launch_id TEXT NOT NULL,
        lane_id TEXT NOT NULL REFERENCES wallet_lanes(lane_id),
        wallet_address TEXT NOT NULL,
        nonce TEXT NOT NULL,
        plan_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (plan_id, revision),
        UNIQUE (wallet_address, nonce, revision)
      );
      INSERT INTO execution_plans SELECT * FROM execution_plans_v4;
      DROP TABLE execution_plans_v4;
      CREATE INDEX idx_execution_plan_hash ON execution_plans(plan_hash);

      ALTER TABLE tx_attempts RENAME TO tx_attempts_v4;
      CREATE TABLE tx_attempts (
        attempt_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        plan_id TEXT NOT NULL,
        strategy_id TEXT NOT NULL,
        launch_id TEXT NOT NULL,
        lane_id TEXT NOT NULL,
        wallet_address TEXT NOT NULL,
        nonce TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (attempt_id, revision),
        UNIQUE (tx_hash, revision)
      );
      INSERT INTO tx_attempts SELECT * FROM tx_attempts_v4;
      DROP TABLE tx_attempts_v4;
      CREATE INDEX idx_attempt_state ON tx_attempts(state, updated_at);
      CREATE INDEX idx_execution_wallet_nonce ON execution_plans(wallet_address, nonce);
    `,
    down: `
      DROP INDEX idx_execution_plan_hash;
      DROP INDEX idx_execution_wallet_nonce;
      DROP INDEX idx_attempt_state;
      ALTER TABLE execution_plans RENAME TO execution_plans_v5;
      CREATE TABLE execution_plans (
        plan_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        strategy_id TEXT NOT NULL,
        launch_id TEXT NOT NULL,
        lane_id TEXT NOT NULL REFERENCES wallet_lanes(lane_id),
        wallet_address TEXT NOT NULL,
        nonce TEXT NOT NULL,
        plan_hash TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (plan_id, revision),
        UNIQUE (wallet_address, nonce)
      );
      INSERT INTO execution_plans
        SELECT current.* FROM execution_plans_v5 current
        JOIN (
          SELECT wallet_address, nonce, MAX(revision) AS revision
          FROM execution_plans_v5 GROUP BY wallet_address, nonce
        ) latest
        ON latest.wallet_address = current.wallet_address
        AND latest.nonce = current.nonce
        AND latest.revision = current.revision;
      DROP TABLE execution_plans_v5;

      ALTER TABLE tx_attempts RENAME TO tx_attempts_v5;
      CREATE TABLE tx_attempts (
        attempt_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        plan_id TEXT NOT NULL,
        strategy_id TEXT NOT NULL,
        launch_id TEXT NOT NULL,
        lane_id TEXT NOT NULL,
        wallet_address TEXT NOT NULL,
        nonce TEXT NOT NULL,
        tx_hash TEXT NOT NULL UNIQUE,
        payload_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (attempt_id, revision)
      );
      INSERT INTO tx_attempts
        SELECT current.* FROM tx_attempts_v5 current
        JOIN (
          SELECT tx_hash, MAX(revision) AS revision
          FROM tx_attempts_v5 GROUP BY tx_hash
        ) latest
        ON latest.tx_hash = current.tx_hash AND latest.revision = current.revision;
      DROP TABLE tx_attempts_v5;
      CREATE INDEX idx_attempt_state ON tx_attempts(state, updated_at);
    `,
  },
]);

interface CountRow {
  readonly value: number | bigint;
}

interface TextRow {
  readonly value: string;
}

export interface AuditEventInput {
  readonly eventId: string;
  readonly eventKind: string;
  readonly strategyId: string;
  readonly launchId?: string;
  readonly objectId: string;
  readonly parentEventId?: string;
  readonly reasonCode?: string;
  readonly payload: unknown;
  readonly observedAt: IsoTimestamp;
}

export interface AuditEventRecord extends AuditEventInput {
  readonly sequence: number;
}

export interface PersistedNonceSlot {
  readonly walletAddress: `0x${string}`;
  readonly nonce: bigint;
  readonly ownerId: string;
  readonly fencingEpoch: number;
  readonly purpose: "ENTRY" | "EXIT" | "RECOVERY" | "TREASURY_SWEEP";
  readonly state:
    | "RESERVED"
    | "SIGNED"
    | "POSSIBLY_SUBMITTED"
    | "CONSUMED"
    | "RELEASED"
    | "UNKNOWN";
  readonly planId: string;
}

function run(statement: StatementSync, ...values: readonly SQLInputValue[]): number {
  return Number(statement.run(...values).changes);
}

function parseStored<T>(value: string): T {
  return JSON.parse(value) as T;
}

function activeReservation(state: ReservationState): boolean {
  return state !== "RELEASED" && state !== "EXPIRED";
}

export class SqliteStore {
  readonly #database: DatabaseSync;
  readonly filename: string;

  constructor(filename: string) {
    this.filename = filename === ":memory:" ? filename : resolve(filename);
    if (this.filename !== ":memory:") {
      mkdirSync(dirname(this.filename), { recursive: true, mode: 0o700 });
    }
    this.#database = new DatabaseSync(this.filename, { timeout: 5_000 });
    this.#database.exec(
      "PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;",
    );
    if (this.filename !== ":memory:") {
      this.#database.exec("PRAGMA journal_mode = WAL;");
      chmodSync(this.filename, 0o600);
    }
    this.#database.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
    );
    this.migrateToLatest();
  }

  close(): void {
    this.#database.close();
  }

  schemaVersion(): number {
    const row = this.#database
      .prepare("SELECT COALESCE(MAX(version), 0) AS value FROM schema_migrations")
      .get() as unknown as CountRow;
    return Number(row.value);
  }

  walEnabled(): boolean {
    const row = this.#database.prepare("PRAGMA journal_mode").get() as unknown as
      | { journal_mode?: string }
      | undefined;
    return row?.journal_mode?.toLowerCase() === "wal";
  }

  migrateToLatest(now: IsoTimestamp = new Date().toISOString()): void {
    for (const migration of migrations) {
      if (migration.version <= this.schemaVersion()) continue;
      this.#transaction(() => {
        this.#database.exec(migration.up);
        this.#database
          .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, now);
      });
    }
  }

  rollbackTo(targetVersion: number): void {
    if (!Number.isSafeInteger(targetVersion) || targetVersion < 0) {
      throw new RangeError("targetVersion must be a non-negative safe integer");
    }
    for (const migration of [...migrations].reverse()) {
      if (migration.version <= targetVersion || migration.version > this.schemaVersion()) continue;
      this.#transaction(() => {
        this.#database.exec(migration.down);
        this.#database
          .prepare("DELETE FROM schema_migrations WHERE version = ?")
          .run(migration.version);
      });
    }
  }

  saveSignalEvidence(evidence: SignalEvidence): boolean {
    return (
      run(
        this.#database.prepare(
          `INSERT OR IGNORE INTO signal_evidence
            (evidence_id, strategy_id, revision, source_kind, payload_hash, payload_json, observed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ),
        evidence.evidenceId,
        evidence.strategyId,
        evidence.revision,
        evidence.sourceKind,
        evidence.payloadHash,
        canonicalJson(evidence),
        evidence.observedAt,
      ) === 1
    );
  }

  saveFactoryProfile(profile: FactoryProfile): void {
    this.#database
      .prepare(
        `INSERT INTO factory_profiles
          (profile_id, revision, strategy_id, address, state, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        profile.profileId,
        profile.revision,
        profile.strategyId,
        profile.address,
        profile.state,
        canonicalJson(profile),
        profile.createdAt,
      );
  }

  saveLaunchIdentity(identity: LaunchIdentity): boolean {
    const inserted = run(
      this.#database.prepare(
        `INSERT OR IGNORE INTO launch_identities
          (launch_id, strategy_id, token_address, pool_address, transaction_hash, log_index,
           identity_policy_hash, payload_json, frozen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      identity.launchId,
      identity.strategyId,
      identity.tokenAddress,
      identity.poolAddress,
      identity.transactionHash,
      identity.logIndex,
      identity.identityPolicyHash,
      canonicalJson(identity),
      identity.frozenAt,
    );
    if (inserted === 1) return true;

    const row = this.#database
      .prepare("SELECT payload_json AS value FROM launch_identities WHERE launch_id = ?")
      .get(identity.launchId) as unknown as TextRow | undefined;
    if (row !== undefined && row.value === canonicalJson(identity)) return false;
    throw new CanonicalInvariantError(
      "IDENTITY_CONFLICT",
      `launch identity ${identity.launchId} already exists with different canonical fields`,
    );
  }

  initializeBudget(budget: StrategyBudget, lanes: readonly WalletLane[]): boolean {
    assertDecimalString("budget.principalLimit", budget.principalLimit);
    return this.#transaction(() => {
      const inserted = run(
        this.#database.prepare(
          `INSERT OR IGNORE INTO strategy_budgets
            (budget_id, strategy_id, launch_id, revision, config_hash, principal_limit, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ),
        budget.budgetId,
        budget.strategyId,
        budget.launchId,
        budget.revision,
        budget.configHash,
        budget.principalLimit,
        canonicalJson(budget),
        budget.createdAt,
      );

      for (const lane of lanes) {
        assertDecimalString("lane.maxPrincipalRaw", lane.maxPrincipalRaw);
        this.#database
          .prepare(
            `INSERT OR IGNORE INTO wallet_lanes
              (lane_id, strategy_id, launch_id, wallet_id, wallet_address, tranche_number,
               state, payload_json, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            lane.laneId,
            lane.strategyId,
            budget.launchId,
            lane.walletId,
            lane.address,
            lane.trancheNumber,
            lane.state,
            canonicalJson(lane),
            lane.updatedAt,
          );
      }
      return inserted === 1;
    });
  }

  reserveCapital(reservation: CapitalReservation): boolean {
    assertDecimalString("reservation.principalRaw", reservation.principalRaw);
    if (BigInt(reservation.principalRaw) <= 0n) {
      throw new RangeError("reservation principal must be positive");
    }
    return this.#transaction(() => {
      const budgetRow = this.#database
        .prepare(
          "SELECT principal_limit AS value FROM strategy_budgets WHERE budget_id = ? AND strategy_id = ? AND launch_id = ?",
        )
        .get(reservation.budgetId, reservation.strategyId, reservation.launchId) as
        | (TextRow & Record<string, unknown>)
        | undefined;
      if (budgetRow === undefined) throw new Error(`budget ${reservation.budgetId} does not exist`);

      const existing = this.#database
        .prepare("SELECT payload_json AS value FROM capital_reservations WHERE reservation_id = ?")
        .get(reservation.reservationId) as unknown as TextRow | undefined;
      if (existing !== undefined) {
        if (existing.value === canonicalJson(reservation)) return false;
        throw new CanonicalInvariantError(
          "BUDGET_EXCEEDED",
          `reservation ${reservation.reservationId} already exists with different fields`,
        );
      }

      const rows = this.#database
        .prepare("SELECT principal_raw, state FROM capital_reservations WHERE budget_id = ?")
        .all(reservation.budgetId) as unknown as readonly {
        principal_raw: string;
        state: ReservationState;
      }[];
      const used = rows.reduce(
        (total, row) => total + (activeReservation(row.state) ? BigInt(row.principal_raw) : 0n),
        0n,
      );
      if (used + BigInt(reservation.principalRaw) > BigInt(budgetRow.value)) {
        throw new CanonicalInvariantError(
          "BUDGET_EXCEEDED",
          `reservation exceeds budget ${reservation.budgetId}`,
        );
      }

      this.#database
        .prepare(
          `INSERT INTO capital_reservations
            (reservation_id, strategy_id, budget_id, launch_id, lane_id, intent_id,
             config_hash, principal_raw, state, payload_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          reservation.reservationId,
          reservation.strategyId,
          reservation.budgetId,
          reservation.launchId,
          reservation.laneId,
          reservation.intentId,
          reservation.configHash,
          reservation.principalRaw,
          reservation.state,
          canonicalJson(reservation),
          reservation.createdAt,
          reservation.updatedAt,
        );
      return true;
    });
  }

  updateReservationState(
    reservationId: string,
    state: ReservationState,
    updatedAt: IsoTimestamp,
  ): void {
    const changed = run(
      this.#database.prepare(
        "UPDATE capital_reservations SET state = ?, updated_at = ? WHERE reservation_id = ?",
      ),
      state,
      updatedAt,
      reservationId,
    );
    if (changed !== 1) throw new Error(`reservation ${reservationId} does not exist`);
  }

  settleReservationFromReceipt(
    reservationId: string,
    outcome: "SUCCESS" | "REVERTED" | "UNKNOWN",
    updatedAt: IsoTimestamp,
  ): ReservationState {
    const state: ReservationState =
      outcome === "SUCCESS" ? "SPENT" : outcome === "REVERTED" ? "RELEASED" : "UNKNOWN";
    this.updateReservationState(reservationId, state, updatedAt);
    return state;
  }

  reservationState(reservationId: string): ReservationState | undefined {
    const row = this.#database
      .prepare("SELECT state AS value FROM capital_reservations WHERE reservation_id = ?")
      .get(reservationId) as unknown as TextRow | undefined;
    return row?.value as ReservationState | undefined;
  }

  budgetUsage(budgetId: string): bigint {
    const rows = this.#database
      .prepare("SELECT principal_raw, state FROM capital_reservations WHERE budget_id = ?")
      .all(budgetId) as unknown as readonly { principal_raw: string; state: ReservationState }[];
    return rows.reduce(
      (total, row) => total + (activeReservation(row.state) ? BigInt(row.principal_raw) : 0n),
      0n,
    );
  }

  saveExecutionPlan(plan: ExecutionPlan): void {
    this.#database
      .prepare(
        `INSERT INTO execution_plans
          (plan_id, revision, strategy_id, launch_id, lane_id, wallet_address, nonce,
           plan_hash, state, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        plan.planId,
        plan.revision,
        plan.strategyId,
        plan.launchId,
        plan.laneId,
        plan.walletAddress,
        plan.nonce,
        plan.planHash,
        plan.state,
        canonicalJson(plan),
        plan.createdAt,
      );
  }

  latestExecutionPlans(strategyId: string, launchId: string): readonly ExecutionPlan[] {
    const rows = this.#database
      .prepare(
        `SELECT current.payload_json AS value
           FROM execution_plans current
           JOIN (
             SELECT plan_id, MAX(revision) AS revision
             FROM execution_plans
             WHERE strategy_id = ? AND launch_id = ?
             GROUP BY plan_id
           ) latest ON latest.plan_id = current.plan_id AND latest.revision = current.revision
           ORDER BY current.wallet_address, CAST(current.nonce AS INTEGER)`,
      )
      .all(strategyId, launchId) as unknown as readonly TextRow[];
    return Object.freeze(rows.map((row) => Object.freeze(parseStored<ExecutionPlan>(row.value))));
  }

  saveFeeBandPlan(plan: FeeBandPlan): boolean {
    return (
      run(
        this.#database.prepare(
          `INSERT OR IGNORE INTO fee_band_plans
            (planner_revision, strategy_id, launch_id, mechanism_profile_revision,
             payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ),
        plan.plannerRevision,
        plan.strategyId,
        plan.launchId,
        plan.mechanismProfileRevision,
        canonicalJson(plan),
        plan.createdAt,
      ) === 1
    );
  }

  hasFeeBandPlan(plannerRevision: string): boolean {
    const row = this.#database
      .prepare("SELECT COUNT(*) AS value FROM fee_band_plans WHERE planner_revision = ?")
      .get(plannerRevision) as unknown as CountRow;
    return Number(row.value) === 1;
  }

  saveTxAttempt(attempt: TxAttempt): void {
    this.#database
      .prepare(
        `INSERT INTO tx_attempts
          (attempt_id, revision, plan_id, strategy_id, launch_id, lane_id, wallet_address,
           nonce, tx_hash, payload_hash, state, payload_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attempt.attemptId,
        attempt.revision,
        attempt.planId,
        attempt.strategyId,
        attempt.launchId,
        attempt.laneId,
        attempt.walletAddress,
        attempt.nonce,
        attempt.signedTxHash,
        attempt.payloadHash,
        attempt.state,
        canonicalJson(attempt),
        attempt.updatedAt,
      );
  }

  latestTxAttempts(strategyId: string, launchId?: string): readonly TxAttempt[] {
    const rows = (launchId === undefined
      ? this.#database
          .prepare(
            `SELECT current.payload_json AS value
               FROM tx_attempts current
               JOIN (
                 SELECT attempt_id, MAX(revision) AS revision
                 FROM tx_attempts WHERE strategy_id = ? GROUP BY attempt_id
               ) latest
               ON latest.attempt_id = current.attempt_id AND latest.revision = current.revision
               ORDER BY current.updated_at, current.attempt_id`,
          )
          .all(strategyId)
      : this.#database
          .prepare(
            `SELECT current.payload_json AS value
               FROM tx_attempts current
               JOIN (
                 SELECT attempt_id, MAX(revision) AS revision
                 FROM tx_attempts
                 WHERE strategy_id = ? AND launch_id = ? GROUP BY attempt_id
               ) latest
               ON latest.attempt_id = current.attempt_id AND latest.revision = current.revision
               ORDER BY current.updated_at, current.attempt_id`,
          )
          .all(strategyId, launchId)) as unknown as readonly TextRow[];
    return Object.freeze(rows.map((row) => Object.freeze(parseStored<TxAttempt>(row.value))));
  }

  unresolvedTxAttempts(strategyId: string): readonly TxAttempt[] {
    const terminal = new Set<TxAttempt["state"]>([
      "CONFIRMED_SUCCESS",
      "CONFIRMED_REVERTED",
      "DROPPED_PROVEN",
      "EXPIRED_UNRESOLVED",
    ]);
    return Object.freeze(
      this.latestTxAttempts(strategyId).filter((attempt) => !terminal.has(attempt.state)),
    );
  }

  saveEffectRecord(effect: EffectRecord): void {
    this.#database
      .prepare(
        `INSERT INTO effect_records
          (effect_id, revision, attempt_id, strategy_id, launch_id, lane_id, tx_hash,
           result, canonicality, payload_json, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        effect.effectId,
        effect.revision,
        effect.attemptId,
        effect.strategyId,
        effect.launchId,
        effect.laneId,
        effect.txHash,
        effect.result,
        effect.canonicality,
        canonicalJson(effect),
        effect.observedAt,
      );
  }

  savePositionLot(lot: PositionLot): void {
    assertDecimalString("lot.remainingRaw", lot.remainingRaw);
    this.#database
      .prepare(
        `INSERT INTO position_lots
          (lot_id, revision, strategy_id, launch_id, lane_id, wallet_address, token_address,
           remaining_raw, state, payload_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        lot.lotId,
        lot.revision,
        lot.strategyId,
        lot.launchId,
        lot.laneId,
        lot.walletAddress,
        lot.tokenAddress,
        lot.remainingRaw,
        lot.state,
        canonicalJson(lot),
        lot.updatedAt,
      );
  }

  saveRouteQuote(quote: RouteQuote): void {
    assertDecimalString("quote.netOutputRaw", quote.netOutputRaw);
    this.#database
      .prepare(
        `INSERT INTO route_quotes
          (quote_id, revision, strategy_id, launch_id, lot_id, route_id, net_output_raw,
           expires_at, payload_json, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        quote.quoteId,
        quote.revision,
        quote.strategyId,
        quote.launchId,
        quote.lotId,
        quote.routeId,
        quote.netOutputRaw,
        quote.expiresAt,
        canonicalJson(quote),
        quote.observedAt,
      );
  }

  saveExitPlan(plan: ExitPlan): void {
    this.#database
      .prepare(
        `INSERT INTO exit_plans
          (exit_plan_id, revision, strategy_id, launch_id, lot_id, state, payload_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        plan.exitPlanId,
        plan.revision,
        plan.strategyId,
        plan.launchId,
        plan.lotId,
        plan.state,
        canonicalJson(plan),
        plan.updatedAt,
      );
  }

  latestRouteQuotes(strategyId: string, launchId: string): readonly RouteQuote[] {
    const rows = this.#database
      .prepare(
        `SELECT current.payload_json AS value
           FROM route_quotes current
           JOIN (
             SELECT quote_id, MAX(revision) AS revision
             FROM route_quotes
             WHERE strategy_id = ? AND launch_id = ?
             GROUP BY quote_id
           ) latest ON latest.quote_id = current.quote_id AND latest.revision = current.revision
           ORDER BY current.observed_at, current.quote_id`,
      )
      .all(strategyId, launchId) as unknown as readonly TextRow[];
    return Object.freeze(rows.map((row) => Object.freeze(parseStored<RouteQuote>(row.value))));
  }

  latestExitPlans(strategyId: string, launchId?: string): readonly ExitPlan[] {
    const rows = (launchId === undefined
      ? this.#database
          .prepare(
            `SELECT current.payload_json AS value
               FROM exit_plans current
               JOIN (
                 SELECT exit_plan_id, MAX(revision) AS revision
                 FROM exit_plans WHERE strategy_id = ? GROUP BY exit_plan_id
               ) latest
               ON latest.exit_plan_id = current.exit_plan_id
               AND latest.revision = current.revision
               ORDER BY current.updated_at, current.exit_plan_id`,
          )
          .all(strategyId)
      : this.#database
          .prepare(
            `SELECT current.payload_json AS value
               FROM exit_plans current
               JOIN (
                 SELECT exit_plan_id, MAX(revision) AS revision
                 FROM exit_plans
                 WHERE strategy_id = ? AND launch_id = ? GROUP BY exit_plan_id
               ) latest
               ON latest.exit_plan_id = current.exit_plan_id
               AND latest.revision = current.revision
               ORDER BY current.updated_at, current.exit_plan_id`,
          )
          .all(strategyId, launchId)) as unknown as readonly TextRow[];
    return Object.freeze(rows.map((row) => Object.freeze(parseStored<ExitPlan>(row.value))));
  }

  claimWalletEntryIntent(input: {
    strategyId: string;
    launchId: string;
    walletAddress: `0x${string}`;
    intentId: string;
    createdAt: IsoTimestamp;
  }): boolean {
    const inserted = run(
      this.#database.prepare(
        `INSERT OR IGNORE INTO wallet_entry_claims
          (strategy_id, launch_id, wallet_address, intent_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ),
      input.strategyId,
      input.launchId,
      input.walletAddress.toLowerCase(),
      input.intentId,
      input.createdAt,
    );
    if (inserted === 1) return true;
    const existing = this.#database
      .prepare(
        `SELECT intent_id AS value FROM wallet_entry_claims
         WHERE strategy_id = ? AND launch_id = ? AND wallet_address = ?`,
      )
      .get(input.strategyId, input.launchId, input.walletAddress.toLowerCase()) as
      | (TextRow & Record<string, unknown>)
      | undefined;
    if (existing?.value === input.intentId) return false;
    throw new CanonicalInvariantError(
      "NONCE_CONFLICT",
      "wallet already owns a different entry intent for this strategy launch",
    );
  }

  reserveWalletNonceSlot(slot: PersistedNonceSlot, updatedAt: IsoTimestamp): boolean {
    return this.#transaction(() => {
      const lease = this.#database
        .prepare("SELECT owner_id, fencing_epoch FROM service_leases WHERE resource_key = ?")
        .get(`wallet:${slot.walletAddress.toLowerCase()}`) as unknown as
        | { owner_id: string; fencing_epoch: number | bigint }
        | undefined;
      if (
        lease === undefined ||
        lease.owner_id !== slot.ownerId ||
        Number(lease.fencing_epoch) !== slot.fencingEpoch
      ) {
        throw new CanonicalInvariantError(
          "NONCE_CONFLICT",
          "wallet nonce slot uses a stale or foreign service lease",
        );
      }
      const existing = this.walletNonceSlot(slot.walletAddress, slot.nonce);
      if (existing !== undefined) {
        if (
          existing.ownerId === slot.ownerId &&
          existing.fencingEpoch === slot.fencingEpoch &&
          existing.planId === slot.planId &&
          existing.purpose === slot.purpose
        ) {
          return false;
        }
        throw new CanonicalInvariantError(
          "NONCE_CONFLICT",
          `wallet nonce ${slot.walletAddress}:${slot.nonce} is already reserved`,
        );
      }
      this.#database
        .prepare(
          `INSERT INTO wallet_nonce_slots
            (wallet_address, nonce, owner_id, fencing_epoch, purpose, state, plan_id, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          slot.walletAddress.toLowerCase(),
          slot.nonce.toString(),
          slot.ownerId,
          slot.fencingEpoch,
          slot.purpose,
          slot.state,
          slot.planId,
          updatedAt,
        );
      return true;
    });
  }

  reserveCapitalAndNonceSlot(
    reservation: CapitalReservation,
    slot: PersistedNonceSlot,
    updatedAt: IsoTimestamp,
  ): Readonly<{ reservationCreated: boolean; nonceCreated: boolean }> {
    assertDecimalString("reservation.principalRaw", reservation.principalRaw);
    if (BigInt(reservation.principalRaw) <= 0n) {
      throw new RangeError("reservation principal must be positive");
    }
    return this.#transaction(() => {
      const budgetRow = this.#database
        .prepare(
          "SELECT principal_limit AS value FROM strategy_budgets WHERE budget_id = ? AND strategy_id = ? AND launch_id = ?",
        )
        .get(reservation.budgetId, reservation.strategyId, reservation.launchId) as
        | (TextRow & Record<string, unknown>)
        | undefined;
      if (budgetRow === undefined) throw new Error(`budget ${reservation.budgetId} does not exist`);
      const existingReservation = this.#database
        .prepare("SELECT payload_json AS value FROM capital_reservations WHERE reservation_id = ?")
        .get(reservation.reservationId) as unknown as TextRow | undefined;
      let reservationCreated = false;
      if (existingReservation === undefined) {
        const rows = this.#database
          .prepare("SELECT principal_raw, state FROM capital_reservations WHERE budget_id = ?")
          .all(reservation.budgetId) as unknown as readonly {
          principal_raw: string;
          state: ReservationState;
        }[];
        const used = rows.reduce(
          (total, row) => total + (activeReservation(row.state) ? BigInt(row.principal_raw) : 0n),
          0n,
        );
        if (used + BigInt(reservation.principalRaw) > BigInt(budgetRow.value)) {
          throw new CanonicalInvariantError(
            "BUDGET_EXCEEDED",
            `reservation exceeds budget ${reservation.budgetId}`,
          );
        }
        this.#database
          .prepare(
            `INSERT INTO capital_reservations
              (reservation_id, strategy_id, budget_id, launch_id, lane_id, intent_id,
               config_hash, principal_raw, state, payload_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            reservation.reservationId,
            reservation.strategyId,
            reservation.budgetId,
            reservation.launchId,
            reservation.laneId,
            reservation.intentId,
            reservation.configHash,
            reservation.principalRaw,
            reservation.state,
            canonicalJson(reservation),
            reservation.createdAt,
            reservation.updatedAt,
          );
        reservationCreated = true;
      } else if (existingReservation.value !== canonicalJson(reservation)) {
        throw new CanonicalInvariantError(
          "BUDGET_EXCEEDED",
          `reservation ${reservation.reservationId} already exists with different fields`,
        );
      }

      const lease = this.#database
        .prepare("SELECT owner_id, fencing_epoch FROM service_leases WHERE resource_key = ?")
        .get(`wallet:${slot.walletAddress.toLowerCase()}`) as unknown as
        | { owner_id: string; fencing_epoch: number | bigint }
        | undefined;
      if (
        lease === undefined ||
        lease.owner_id !== slot.ownerId ||
        Number(lease.fencing_epoch) !== slot.fencingEpoch
      ) {
        throw new CanonicalInvariantError(
          "NONCE_CONFLICT",
          "wallet nonce slot uses a stale or foreign service lease",
        );
      }
      const existingSlot = this.walletNonceSlot(slot.walletAddress, slot.nonce);
      let nonceCreated = false;
      if (existingSlot === undefined) {
        this.#database
          .prepare(
            `INSERT INTO wallet_nonce_slots
              (wallet_address, nonce, owner_id, fencing_epoch, purpose, state, plan_id, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            slot.walletAddress.toLowerCase(),
            slot.nonce.toString(),
            slot.ownerId,
            slot.fencingEpoch,
            slot.purpose,
            slot.state,
            slot.planId,
            updatedAt,
          );
        nonceCreated = true;
      } else if (
        existingSlot.ownerId !== slot.ownerId ||
        existingSlot.fencingEpoch !== slot.fencingEpoch ||
        existingSlot.planId !== slot.planId ||
        existingSlot.purpose !== slot.purpose
      ) {
        throw new CanonicalInvariantError(
          "NONCE_CONFLICT",
          `wallet nonce ${slot.walletAddress}:${slot.nonce} is already reserved`,
        );
      }
      return Object.freeze({ reservationCreated, nonceCreated });
    });
  }

  walletNonceSlot(walletAddress: `0x${string}`, nonce: bigint): PersistedNonceSlot | undefined {
    const row = this.#database
      .prepare(
        `SELECT wallet_address, nonce, owner_id, fencing_epoch, purpose, state, plan_id
         FROM wallet_nonce_slots WHERE wallet_address = ? AND nonce = ?`,
      )
      .get(walletAddress.toLowerCase(), nonce.toString()) as unknown as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) return undefined;
    return Object.freeze({
      walletAddress: String(row.wallet_address) as `0x${string}`,
      nonce: BigInt(String(row.nonce)),
      ownerId: String(row.owner_id),
      fencingEpoch: Number(row.fencing_epoch),
      purpose: String(row.purpose) as PersistedNonceSlot["purpose"],
      state: String(row.state) as PersistedNonceSlot["state"],
      planId: String(row.plan_id),
    });
  }

  updateWalletNonceSlot(
    slot: PersistedNonceSlot,
    state: PersistedNonceSlot["state"],
    updatedAt: IsoTimestamp,
  ): PersistedNonceSlot {
    const changed = run(
      this.#database.prepare(
        `UPDATE wallet_nonce_slots SET state = ?, updated_at = ?
         WHERE wallet_address = ? AND nonce = ? AND owner_id = ? AND fencing_epoch = ? AND plan_id = ?`,
      ),
      state,
      updatedAt,
      slot.walletAddress.toLowerCase(),
      slot.nonce.toString(),
      slot.ownerId,
      slot.fencingEpoch,
      slot.planId,
    );
    if (changed !== 1) {
      throw new CanonicalInvariantError("NONCE_CONFLICT", "nonce slot ownership mismatch");
    }
    return Object.freeze({ ...slot, state });
  }

  walletHasUnresolvedNonce(walletAddress: `0x${string}`): boolean {
    const row = this.#database
      .prepare(
        `SELECT COUNT(*) AS value FROM wallet_nonce_slots
         WHERE wallet_address = ?
           AND state IN ('RESERVED', 'SIGNED', 'POSSIBLY_SUBMITTED', 'UNKNOWN')`,
      )
      .get(walletAddress.toLowerCase()) as unknown as CountRow;
    return Number(row.value) > 0;
  }

  latestPositionLots(strategyId: string, launchId: string): readonly PositionLot[] {
    const rows = this.#database
      .prepare(
        `SELECT current.payload_json AS value
           FROM position_lots current
           JOIN (
             SELECT lot_id, MAX(revision) AS revision
             FROM position_lots
             WHERE strategy_id = ? AND launch_id = ?
             GROUP BY lot_id
           ) latest ON latest.lot_id = current.lot_id AND latest.revision = current.revision
           ORDER BY current.lot_id`,
      )
      .all(strategyId, launchId) as unknown as readonly TextRow[];
    return Object.freeze(rows.map((row) => Object.freeze(parseStored<PositionLot>(row.value))));
  }

  latestOpenPositionLots(strategyId: string): readonly PositionLot[] {
    const rows = this.#database
      .prepare(
        `SELECT current.payload_json AS value
           FROM position_lots current
           JOIN (
             SELECT lot_id, MAX(revision) AS revision
             FROM position_lots WHERE strategy_id = ? GROUP BY lot_id
           ) latest ON latest.lot_id = current.lot_id AND latest.revision = current.revision
           WHERE current.state IN ('OPEN', 'PARTIALLY_EXITED', 'EXIT_PENDING', 'UNKNOWN')
           ORDER BY current.updated_at, current.lot_id`,
      )
      .all(strategyId) as unknown as readonly TextRow[];
    return Object.freeze(rows.map((row) => Object.freeze(parseStored<PositionLot>(row.value))));
  }

  latestLaunchIdentities(strategyId: string): readonly LaunchIdentity[] {
    const rows = this.#database
      .prepare(
        `SELECT payload_json AS value FROM launch_identities
         WHERE strategy_id = ? ORDER BY frozen_at, launch_id`,
      )
      .all(strategyId) as unknown as readonly TextRow[];
    return Object.freeze(rows.map((row) => Object.freeze(parseStored<LaunchIdentity>(row.value))));
  }

  latestEffectRecords(strategyId: string, launchId: string): readonly EffectRecord[] {
    const rows = this.#database
      .prepare(
        `SELECT current.payload_json AS value
           FROM effect_records current
           JOIN (
             SELECT effect_id, MAX(revision) AS revision
             FROM effect_records
             WHERE strategy_id = ? AND launch_id = ?
             GROUP BY effect_id
           ) latest ON latest.effect_id = current.effect_id AND latest.revision = current.revision
           ORDER BY current.effect_id`,
      )
      .all(strategyId, launchId) as unknown as readonly TextRow[];
    return Object.freeze(rows.map((row) => Object.freeze(parseStored<EffectRecord>(row.value))));
  }

  appendAuditEvent(event: AuditEventInput): number {
    const result = this.#database
      .prepare(
        `INSERT INTO audit_events
          (event_id, event_kind, strategy_id, launch_id, object_id, parent_event_id,
           reason_code, payload_json, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.eventId,
        event.eventKind,
        event.strategyId,
        event.launchId ?? null,
        event.objectId,
        event.parentEventId ?? null,
        event.reasonCode ?? null,
        canonicalJson(event.payload),
        event.observedAt,
      );
    return Number(result.lastInsertRowid);
  }

  auditEvents(strategyId: string, launchId?: string): readonly AuditEventRecord[] {
    const rows = (launchId === undefined
      ? this.#database
          .prepare("SELECT * FROM audit_events WHERE strategy_id = ? ORDER BY sequence")
          .all(strategyId)
      : this.#database
          .prepare(
            "SELECT * FROM audit_events WHERE strategy_id = ? AND launch_id = ? ORDER BY sequence",
          )
          .all(strategyId, launchId)) as unknown as readonly Record<string, unknown>[];

    return Object.freeze(
      rows.map((row) => {
        const result: AuditEventRecord = {
          sequence: Number(row.sequence),
          eventId: String(row.event_id),
          eventKind: String(row.event_kind),
          strategyId: String(row.strategy_id),
          objectId: String(row.object_id),
          payload: parseStored(String(row.payload_json)),
          observedAt: String(row.observed_at),
          ...(row.launch_id === null ? {} : { launchId: String(row.launch_id) }),
          ...(row.parent_event_id === null ? {} : { parentEventId: String(row.parent_event_id) }),
          ...(row.reason_code === null ? {} : { reasonCode: String(row.reason_code) }),
        };
        return Object.freeze(result);
      }),
    );
  }

  acquireServiceLease(
    resourceKey: string,
    ownerId: string,
    expiresAt: IsoTimestamp,
    now: IsoTimestamp,
  ): number {
    return this.#transaction(() => {
      const row = this.#database
        .prepare(
          "SELECT owner_id, fencing_epoch, expires_at FROM service_leases WHERE resource_key = ?",
        )
        .get(resourceKey) as unknown as
        | { owner_id: string; fencing_epoch: number | bigint; expires_at: string }
        | undefined;
      if (row !== undefined && row.expires_at > now && row.owner_id !== ownerId) {
        throw new CanonicalInvariantError(
          "NONCE_CONFLICT",
          `resource ${resourceKey} is leased by ${row.owner_id}`,
        );
      }
      const epoch = row === undefined ? 1 : Number(row.fencing_epoch) + 1;
      this.#database
        .prepare(
          `INSERT INTO service_leases(resource_key, owner_id, fencing_epoch, expires_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(resource_key) DO UPDATE SET
             owner_id = excluded.owner_id,
             fencing_epoch = excluded.fencing_epoch,
             expires_at = excluded.expires_at,
             updated_at = excluded.updated_at`,
        )
        .run(resourceKey, ownerId, epoch, expiresAt, now);
      return epoch;
    });
  }

  renewServiceLease(
    resourceKey: string,
    ownerId: string,
    fencingEpoch: number,
    expiresAt: IsoTimestamp,
    now: IsoTimestamp,
  ): void {
    if (expiresAt <= now) throw new RangeError("renewed service lease must expire in the future");
    const changed = run(
      this.#database.prepare(
        `UPDATE service_leases SET expires_at = ?, updated_at = ?
         WHERE resource_key = ? AND owner_id = ? AND fencing_epoch = ? AND expires_at > ?`,
      ),
      expiresAt,
      now,
      resourceKey,
      ownerId,
      fencingEpoch,
      now,
    );
    if (changed !== 1) {
      throw new CanonicalInvariantError(
        "NONCE_CONFLICT",
        `resource ${resourceKey} lease is not owned`,
      );
    }
  }

  ownsServiceLease(
    resourceKey: string,
    ownerId: string,
    fencingEpoch: number,
    now: IsoTimestamp,
  ): boolean {
    const row = this.#database
      .prepare(
        `SELECT COUNT(*) AS value FROM service_leases
         WHERE resource_key = ? AND owner_id = ? AND fencing_epoch = ? AND expires_at > ?`,
      )
      .get(resourceKey, ownerId, fencingEpoch, now) as unknown as CountRow;
    return Number(row.value) === 1;
  }

  releaseServiceLease(
    resourceKey: string,
    ownerId: string,
    fencingEpoch: number,
    now: IsoTimestamp,
  ): void {
    const changed = run(
      this.#database.prepare(
        `UPDATE service_leases SET expires_at = ?, updated_at = ?
         WHERE resource_key = ? AND owner_id = ? AND fencing_epoch = ?`,
      ),
      now,
      now,
      resourceKey,
      ownerId,
      fencingEpoch,
    );
    if (changed !== 1) {
      throw new CanonicalInvariantError(
        "NONCE_CONFLICT",
        `resource ${resourceKey} lease cannot be released by a foreign owner`,
      );
    }
  }

  tableCount(table: string): number {
    const allowed = new Set([
      "factory_profiles",
      "signal_evidence",
      "launch_identities",
      "strategy_budgets",
      "wallet_lanes",
      "capital_reservations",
      "execution_plans",
      "tx_attempts",
      "effect_records",
      "position_lots",
      "route_quotes",
      "exit_plans",
      "audit_events",
      "service_leases",
      "wallet_entry_claims",
      "wallet_nonce_slots",
      "fee_band_plans",
    ]);
    if (!allowed.has(table)) throw new RangeError(`unsupported table ${table}`);
    const row = this.#database
      .prepare(`SELECT COUNT(*) AS value FROM ${table}`)
      .get() as unknown as CountRow;
    return Number(row.value);
  }

  #transaction<T>(callback: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const value = callback();
      this.#database.exec("COMMIT");
      return value;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}
