import type { DB } from "../db.js";
import { TaskEngine, type TaskRow } from "./engine.js";
import { ApiError } from "./engine.js";

/**
 * Operate — teleoperation sessions with a safety gate, and the flywheel:
 * every completed intervention becomes an annotation task whose output is a
 * training-ready demonstration ("every intervention is a labeled demonstration").
 *
 * Transport (LiveKit) is out of scope here; this service owns the lifecycle,
 * the safety-confirmation binary, operator selection, and the data exhaust.
 */

export interface TeleopSessionRow {
  id: string;
  org_id: string;
  robot_id: string;
  context: Record<string, unknown>;
  control_scope: Record<string, unknown>;
  status: "requested" | "safety_check" | "denied" | "active" | "handback" | "completed" | "failed";
  safety_task_id: string | null;
  operator_id: string | null;
  recording_url: string | null;
  demonstration_task_id: string | null;
  requested_at: Date;
  started_at: Date | null;
  ended_at: Date | null;
}

export class TeleopService {
  constructor(private db: DB, private tasks: TaskEngine) {}

  /** Robot escalates: create the session and the $0.50 safety-confirmation binary. */
  async requestSession(
    orgId: string,
    input: { robotId: string; context?: Record<string, unknown>; controlScope?: Record<string, unknown> },
  ): Promise<TeleopSessionRow> {
    const { rows } = await this.db.query<TeleopSessionRow>(
      `insert into teleop_sessions (org_id, robot_id, context, control_scope, status)
       values ($1,$2,$3,$4,'safety_check') returning *`,
      [orgId, input.robotId, JSON.stringify(input.context ?? {}), JSON.stringify(input.controlScope ?? {})],
    );
    const session = rows[0]!;

    const { task } = await this.tasks.createTask({
      orgId,
      primitive: "safety_confirm",
      tier: "basic",
      payload: {
        question:
          `Is it safe to grant a remote operator the requested control scope on robot ${input.robotId}?`,
        context: input.context ?? {},
        control_scope: input.controlScope ?? {},
      },
      skillTags: ["teleop_safety"],
      parentKind: "teleop",
      parentId: session.id,
    });
    await this.db.query(`update teleop_sessions set safety_task_id = $2 where id = $1`, [session.id, task.id]);
    return (await this.getSession(session.id))!;
  }

  /** Hook for TaskEngine: advance the session when its safety binary resolves. */
  async onTaskFinished(task: TaskRow): Promise<void> {
    if (task.parent_kind !== "teleop" || !task.parent_id) return;
    const session = await this.getSession(task.parent_id);
    if (!session) return;

    if (task.id === session.safety_task_id && session.status === "safety_check") {
      const approved =
        task.status === "completed" &&
        String(task.result?.["answer"] ?? "").toLowerCase() === "yes";
      if (!approved) {
        await this.db.query(
          `update teleop_sessions set status='denied', ended_at=now() where id=$1`,
          [session.id],
        );
        return;
      }
      const operator = await this.tasks.pickWorker("expert", ["teleop"]);
      if (!operator) {
        await this.db.query(
          `update teleop_sessions set status='failed', ended_at=now() where id=$1`,
          [session.id],
        );
        return;
      }
      await this.db.query(
        `update teleop_sessions set status='active', operator_id=$2, started_at=now() where id=$1`,
        [session.id, operator.id],
      );
    }
  }

  /** Operator hands control back; the recording becomes a demonstration annotation task. */
  async handback(
    sessionId: string,
    orgId: string,
    input: { recordingUrl?: string; resolution?: string },
  ): Promise<TeleopSessionRow> {
    const session = await this.getSession(sessionId);
    if (!session || session.org_id !== orgId) throw new ApiError(404, "session not found");
    if (session.status !== "active") throw new ApiError(409, `session is ${session.status}`);

    const { task } = await this.tasks.createTask({
      orgId,
      primitive: "annotate",
      tier: "complex",
      payload: {
        instruction:
          "Annotate this teleoperation intervention as a training demonstration: segment phases, label objects and actions, flag any unsafe moments.",
        recording_url: input.recordingUrl ?? null,
        robot_id: session.robot_id,
        context: session.context,
        resolution: input.resolution ?? null,
      },
      skillTags: ["video_labeling"],
      parentKind: "teleop",
      parentId: session.id,
      billable: false, // included in intervention pricing
    });

    await this.db.query(
      `update teleop_sessions set status='completed', recording_url=$2, demonstration_task_id=$3, ended_at=now()
        where id=$1`,
      [sessionId, input.recordingUrl ?? null, task.id],
    );
    return (await this.getSession(sessionId))!;
  }

  async getSession(id: string): Promise<TeleopSessionRow | null> {
    const { rows } = await this.db.query<TeleopSessionRow>(`select * from teleop_sessions where id = $1`, [id]);
    return rows[0] ?? null;
  }
}

export function publicSession(s: TeleopSessionRow) {
  return {
    id: s.id,
    robot_id: s.robot_id,
    status: s.status,
    control_scope: s.control_scope,
    safety_task_id: s.safety_task_id,
    operator_assigned: s.operator_id != null,
    recording_url: s.recording_url,
    demonstration_task_id: s.demonstration_task_id,
    requested_at: s.requested_at,
    started_at: s.started_at,
    ended_at: s.ended_at,
  };
}
