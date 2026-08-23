export type PersonnelRole = "dispatcher" | "field" | "hospital_admin" | "admin";

export type IncidentStatus =
  | "reported"
  | "triaged"
  | "dispatched"
  | "en_route"
  | "on_scene"
  | "transporting"
  | "resolved"
  | "closed"
  | "cancelled";

export type PriorityTier = "low" | "medium" | "high" | "critical";

export type UnitStatus =
  | "available"
  | "assigned"
  | "en_route"
  | "on_scene"
  | "transporting"
  | "offline"
  | "out_of_service";

export interface Agency {
  id: string;
  name: string;
  created_at: string;
}

export interface Personnel {
  id: string;
  agency_id: string;
  role: PersonnelRole;
  full_name: string | null;
  phone: string | null;
  locale: "en" | "es";
  hospital_id: string | null;
}

export interface Unit {
  id: string;
  agency_id: string;
  callsign: string;
  unit_type: string;
  capabilities: string[];
  capacity: number;
  status: UnitStatus;
  current_lat: number | null;
  current_lng: number | null;
  assigned_to: string | null;
  last_fix_at: string | null;
}

export interface Hospital {
  id: string;
  agency_id: string;
  name: string;
  current_lat: number;
  current_lng: number;
  total_beds: number;
  beds_available: number;
  diversion: boolean;
  diversion_reason: string | null;
  diversion_updated_at: string | null;
  last_capacity_update_at: string;
}

export interface Incident {
  id: string;
  agency_id: string;
  tracking_code: string;
  status: IncidentStatus;
  priority_tier: PriorityTier;
  source: "citizen" | "dispatcher";
  description: string;
  current_lat: number;
  current_lng: number;
  photo_path: string | null;
  reporter_ref: string | null;
  created_by: string | null;
  escalation_count: number;
  created_at: string;
  updated_at: string;
  triaged_at: string | null;
  dispatched_at: string | null;
  closed_at: string | null;
}

export interface TriageScore {
  id: string;
  incident_id: string;
  computed_score: number;
  computed_tier: PriorityTier;
  override_score: number | null;
  override_tier: PriorityTier | null;
  scored_by: string | null;
  algorithm_version: string;
  vitals: Record<string, unknown> | null;
  source: "auto" | "field" | "dispatcher";
  client_mutation_id: string | null;
  created_at: string;
}

export interface ResourceClaim {
  id: string;
  incident_id: string;
  unit_id: string;
  is_primary: boolean;
  status: "proposed" | "finalized" | "active" | "completed" | "cancelled" | "rejected";
  proposed_by: "auto_matcher" | "dispatcher" | "field";
  claimed_by: string | null;
  destination_hospital_id: string | null;
  created_at: string;
  finalized_at: string | null;
  completed_at: string | null;
}

export interface AppNotification {
  id: string;
  agency_id: string;
  recipient_user: string | null;
  target_role: PersonnelRole | null;
  incident_id: string | null;
  type: string;
  title: string;
  body: string | null;
  channel: string;
  delivery_status: string;
  payload: Record<string, unknown> | null;
  created_at: string;
  read_at: string | null;
}

/** Typed PostgREST/RPC domain errors (migration 0003 assumption A2). */
export const TG = {
  UNIT_ALREADY_CLAIMED: "TG100",
  INCIDENT_NOT_DISPATCHABLE: "TG102",
  HOSPITAL_ON_DIVERSION: "TG104",
  HOSPITAL_AT_CAPACITY: "TG105",
  NOT_AUTHORIZED: "TG106",
} as const;

export function tgToken(message: string | undefined | null): string | null {
  if (!message) return null;
  if (message.startsWith("INVALID_TRANSITION")) return "INVALID_TRANSITION";
  for (const v of Object.values(TG)) {
    if (message.includes(v)) return v;
  }
  return null;
}
