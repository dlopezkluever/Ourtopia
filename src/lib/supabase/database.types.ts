
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {

  "graphql_public": {
          Tables: {
            [_ in never]: never
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "graphql":
{ Args: { "extensions"?: Json,"operationName"?: string,"query"?: string,"variables"?: Json }; Returns: Json
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"public": {
          Tables: {
            "billing_accounts": {
                  Row: {
                    "account_id": string,"created_at": string,"customer_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "account_id": string,"created_at"?: string,"customer_id"?: string | null
                  }
                  Update: {
                    "account_id"?: string,"created_at"?: string,"customer_id"?: string | null
                  }
                  Relationships: [

                  ]
                },"billing_jobs": {
                  Row: {
                    "account_id": string,"checkout_url": string | null,"claim_token": string | null,"community_id": string,"created_at": string,"expires_at": string | null,"id": string,"kind": string,"last_error": string | null,"lease_until": string | null,"session_id": string | null,"state": string,"subscription_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "account_id": string,"checkout_url"?: string | null,"claim_token"?: string | null,"community_id": string,"created_at"?: string,"expires_at"?: string | null,"id"?: string,"kind": string,"last_error"?: string | null,"lease_until"?: string | null,"session_id"?: string | null,"state"?: string,"subscription_id"?: string | null
                  }
                  Update: {
                    "account_id"?: string,"checkout_url"?: string | null,"claim_token"?: string | null,"community_id"?: string,"created_at"?: string,"expires_at"?: string | null,"id"?: string,"kind"?: string,"last_error"?: string | null,"lease_until"?: string | null,"session_id"?: string | null,"state"?: string,"subscription_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "billing_jobs_account_id_fkey"
      columns: ["account_id"]
isOneToOne: false
      referencedRelation: "billing_accounts"
      referencedColumns: ["account_id"]
    },{
      foreignKeyName: "billing_jobs_community_id_fkey"
      columns: ["community_id"]
isOneToOne: false
      referencedRelation: "communities"
      referencedColumns: ["id"]
    }
                  ]
                },"billing_subscriptions": {
                  Row: {
                    "account_id": string,"cancel_at_period_end": boolean,"customer_id": string,"reconciled_at": string,"status": string,"subscription_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "account_id": string,"cancel_at_period_end": boolean,"customer_id": string,"reconciled_at"?: string,"status": string,"subscription_id": string
                  }
                  Update: {
                    "account_id"?: string,"cancel_at_period_end"?: boolean,"customer_id"?: string,"reconciled_at"?: string,"status"?: string,"subscription_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "billing_subscriptions_account_id_fkey"
      columns: ["account_id"]
isOneToOne: false
      referencedRelation: "billing_accounts"
      referencedColumns: ["account_id"]
    },{
      foreignKeyName: "billing_subscriptions_customer_id_fkey"
      columns: ["customer_id"]
isOneToOne: false
      referencedRelation: "billing_accounts"
      referencedColumns: ["customer_id"]
    }
                  ]
                },"command_intents": {
                  Row: {
                    "actor_id": string,"command": string,"created_at": string,"intent_id": string,"payload": NonNullable<Json>,"result": NonNullable<Json>
                  }
                  ComputedFields: never
                  Insert: {
                    "actor_id": string,"command": string,"created_at"?: string,"intent_id": string,"payload": NonNullable<Json>,"result": NonNullable<Json>
                  }
                  Update: {
                    "actor_id"?: string,"command"?: string,"created_at"?: string,"intent_id"?: string,"payload"?: NonNullable<Json>,"result"?: NonNullable<Json>
                  }
                  Relationships: [

                  ]
                },"communities": {
                  Row: {
                    "created_at": string,"created_by": string,"description": string,"id": string,"name": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by": string,"description"?: string,"id"?: string,"name": string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string,"description"?: string,"id"?: string,"name"?: string
                  }
                  Relationships: [

                  ]
                },"community_events": {
                  Row: {
                    "actor_id": string,"community_id": string,"created_at": string,"id": string,"intent_id": string,"kind": string
                  }
                  ComputedFields: never
                  Insert: {
                    "actor_id": string,"community_id": string,"created_at"?: string,"id"?: string,"intent_id": string,"kind": string
                  }
                  Update: {
                    "actor_id"?: string,"community_id"?: string,"created_at"?: string,"id"?: string,"intent_id"?: string,"kind"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "community_events_community_id_fkey"
      columns: ["community_id"]
isOneToOne: false
      referencedRelation: "communities"
      referencedColumns: ["id"]
    }
                  ]
                },"invites": {
                  Row: {
                    "community_id": string,"community_name": string,"created_at": string,"expires_at": string,"id": string,"issued_by": string,"recipient_email": string,"redeemed_at": string | null,"redeemed_by": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "community_id": string,"community_name": string,"created_at"?: string,"expires_at": string,"id"?: string,"issued_by": string,"recipient_email": string,"redeemed_at"?: string | null,"redeemed_by"?: string | null
                  }
                  Update: {
                    "community_id"?: string,"community_name"?: string,"created_at"?: string,"expires_at"?: string,"id"?: string,"issued_by"?: string,"recipient_email"?: string,"redeemed_at"?: string | null,"redeemed_by"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "invites_community_id_fkey"
      columns: ["community_id"]
isOneToOne: false
      referencedRelation: "communities"
      referencedColumns: ["id"]
    }
                  ]
                },"membership_access_hints": {
                  Row: {
                    "community_id": string,"id": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "community_id": string,"id"?: string,"user_id": string
                  }
                  Update: {
                    "community_id"?: string,"id"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "membership_access_hints_community_id_fkey"
      columns: ["community_id"]
isOneToOne: false
      referencedRelation: "communities"
      referencedColumns: ["id"]
    }
                  ]
                },"membership_applications": {
                  Row: {
                    "applicant_email": string,"applicant_id": string,"application_event_id": string,"community_id": string,"community_name": string,"created_at": string,"decided_at": string | null,"decided_by": string | null,"decision_event_id": string | null,"id": string,"invite_id": string,"reason": string | null,"status": string
                  }
                  ComputedFields: never
                  Insert: {
                    "applicant_email": string,"applicant_id": string,"application_event_id": string,"community_id": string,"community_name": string,"created_at"?: string,"decided_at"?: string | null,"decided_by"?: string | null,"decision_event_id"?: string | null,"id"?: string,"invite_id": string,"reason"?: string | null,"status"?: string
                  }
                  Update: {
                    "applicant_email"?: string,"applicant_id"?: string,"application_event_id"?: string,"community_id"?: string,"community_name"?: string,"created_at"?: string,"decided_at"?: string | null,"decided_by"?: string | null,"decision_event_id"?: string | null,"id"?: string,"invite_id"?: string,"reason"?: string | null,"status"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "membership_applications_application_event_id_fkey"
      columns: ["application_event_id"]
isOneToOne: false
      referencedRelation: "community_events"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "membership_applications_community_id_fkey"
      columns: ["community_id"]
isOneToOne: false
      referencedRelation: "communities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "membership_applications_decision_event_id_fkey"
      columns: ["decision_event_id"]
isOneToOne: true
      referencedRelation: "community_events"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "membership_applications_invite_id_community_id_fkey"
      columns: ["invite_id","community_id"]
isOneToOne: false
      referencedRelation: "invites"
      referencedColumns: ["id","community_id"]
    }
                  ]
                },"membership_settings": {
                  Row: {
                    "invite_lifetime": string,"singleton": boolean
                  }
                  ComputedFields: never
                  Insert: {
                    "invite_lifetime"?: string,"singleton"?: boolean
                  }
                  Update: {
                    "invite_lifetime"?: string,"singleton"?: boolean
                  }
                  Relationships: [

                  ]
                },"memberships": {
                  Row: {
                    "community_id": string,"created_at": string,"role": string,"status": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "community_id": string,"created_at"?: string,"role": string,"status": string,"user_id": string
                  }
                  Update: {
                    "community_id"?: string,"created_at"?: string,"role"?: string,"status"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "memberships_community_id_fkey"
      columns: ["community_id"]
isOneToOne: false
      referencedRelation: "communities"
      referencedColumns: ["id"]
    }
                  ]
                },"notification_attempts": {
                  Row: {
                    "error": string | null,"finished_at": string | null,"id": string,"number": number,"outbox_id": string,"started_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "error"?: string | null,"finished_at"?: string | null,"id": string,"number": number,"outbox_id": string,"started_at"?: string
                  }
                  Update: {
                    "error"?: string | null,"finished_at"?: string | null,"id"?: string,"number"?: number,"outbox_id"?: string,"started_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "notification_attempts_outbox_id_fkey"
      columns: ["outbox_id"]
isOneToOne: false
      referencedRelation: "notification_outbox"
      referencedColumns: ["id"]
    }
                  ]
                },"notification_hints": {
                  Row: {
                    "id": string,"recipient_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "id"?: string,"recipient_id": string
                  }
                  Update: {
                    "id"?: string,"recipient_id"?: string
                  }
                  Relationships: [

                  ]
                },"notification_outbox": {
                  Row: {
                    "application_id": string | null,"attempts": number,"channel": string,"claim_token": string | null,"community_id": string,"created_at": string,"delivered_at": string | null,"event_id": string,"id": string,"kind": string,"last_error": string | null,"lease_until": string | null,"next_attempt_at": string,"recipient_id": string,"state": string
                  }
                  ComputedFields: never
                  Insert: {
                    "application_id"?: string | null,"attempts"?: number,"channel": string,"claim_token"?: string | null,"community_id": string,"created_at"?: string,"delivered_at"?: string | null,"event_id": string,"id"?: string,"kind": string,"last_error"?: string | null,"lease_until"?: string | null,"next_attempt_at"?: string,"recipient_id": string,"state"?: string
                  }
                  Update: {
                    "application_id"?: string | null,"attempts"?: number,"channel"?: string,"claim_token"?: string | null,"community_id"?: string,"created_at"?: string,"delivered_at"?: string | null,"event_id"?: string,"id"?: string,"kind"?: string,"last_error"?: string | null,"lease_until"?: string | null,"next_attempt_at"?: string,"recipient_id"?: string,"state"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "notification_outbox_application_id_fkey"
      columns: ["application_id"]
isOneToOne: false
      referencedRelation: "membership_applications"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "notification_outbox_community_id_fkey"
      columns: ["community_id"]
isOneToOne: false
      referencedRelation: "communities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "notification_outbox_event_id_fkey"
      columns: ["event_id"]
isOneToOne: false
      referencedRelation: "community_events"
      referencedColumns: ["id"]
    }
                  ]
                },"notifications": {
                  Row: {
                    "application_id": string | null,"created_at": string,"id": string,"kind": string,"outbox_id": string,"recipient_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "application_id"?: string | null,"created_at"?: string,"id"?: string,"kind": string,"outbox_id": string,"recipient_id": string
                  }
                  Update: {
                    "application_id"?: string | null,"created_at"?: string,"id"?: string,"kind"?: string,"outbox_id"?: string,"recipient_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "notifications_application_id_fkey"
      columns: ["application_id"]
isOneToOne: false
      referencedRelation: "membership_applications"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "notifications_outbox_id_fkey"
      columns: ["outbox_id"]
isOneToOne: true
      referencedRelation: "notification_outbox"
      referencedColumns: ["id"]
    }
                  ]
                },"stripe_receipts": {
                  Row: {
                    "attempts": number,"customer_id": string | null,"event_id": string,"event_type": string,"fingerprint": string,"last_error": string | null,"processed_at": string | null,"received_at": string,"result": Json | null,"state": string,"subscription_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "attempts"?: number,"customer_id"?: string | null,"event_id": string,"event_type": string,"fingerprint": string,"last_error"?: string | null,"processed_at"?: string | null,"received_at"?: string,"result"?: Json | null,"state"?: string,"subscription_id"?: string | null
                  }
                  Update: {
                    "attempts"?: number,"customer_id"?: string | null,"event_id"?: string,"event_type"?: string,"fingerprint"?: string,"last_error"?: string | null,"processed_at"?: string | null,"received_at"?: string,"result"?: Json | null,"state"?: string,"subscription_id"?: string | null
                  }
                  Relationships: [

                  ]
                },"stripe_writers": {
                  Row: {
                    "claim_token": string,"event_id": string,"lease_until": string,"subscription_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "claim_token": string,"event_id": string,"lease_until": string,"subscription_id": string
                  }
                  Update: {
                    "claim_token"?: string,"event_id"?: string,"lease_until"?: string,"subscription_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "stripe_writers_event_id_fkey"
      columns: ["event_id"]
isOneToOne: false
      referencedRelation: "stripe_receipts"
      referencedColumns: ["event_id"]
    }
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "can_read_invite":
{ Args: { "p_invite_id": string }; Returns: boolean
                           },
"claim_notification":
{ Args: { "p_outbox_id"?: string }; Returns: Json
                           },
"claim_stripe_receipt":
{ Args: { "p_event_id": string }; Returns: Json
                           },
"claim_test_billing":
{ Args: { "p_job_id": string }; Returns: Json
                           },
"create_community":
{ Args: { "p_description"?: string,"p_intent_id": string,"p_name": string }; Returns: Json
                           },
"decide_membership":
{ Args: { "p_application_id": string,"p_decision": string,"p_intent_id": string,"p_reason"?: string }; Returns: Json
                           },
"finish_notification":
{ Args: { "p_claim_token": string,"p_error"?: string,"p_outbox_id": string }; Returns: Json
                           },
"finish_stripe_receipt":
{ Args: { "p_account_id"?: string,"p_cancel_at_period_end"?: boolean,"p_checkout_job_id"?: string,"p_claim_token": string,"p_event_id": string,"p_failed"?: boolean,"p_status"?: string }; Returns: Json
                           },
"finish_test_billing":
{ Args: { "p_checkout_url"?: string,"p_claim_token": string,"p_expires_at"?: string,"p_failed"?: boolean,"p_job_id": string,"p_session_id"?: string }; Returns: Json
                           },
"is_active_member":
{ Args: { "target_community": string }; Returns: boolean
                           },
"is_community_administrator":
{ Args: { "p_community_id": string }; Returns: boolean
                           },
"issue_invite":
{ Args: { "p_community_id": string,"p_email": string,"p_intent_id": string }; Returns: Json
                           },
"link_test_customer":
{ Args: { "p_claim_token": string,"p_customer_id": string,"p_job_id": string }; Returns: undefined
                           },
"receive_stripe_receipt":
{ Args: { "p_customer_id": string,"p_event_id": string,"p_event_type": string,"p_fingerprint": string,"p_subscription_id": string }; Returns: Json
                           },
"redeem_invite":
{ Args: { "p_intent_id": string,"p_invite_id": string }; Returns: Json
                           },
"request_test_billing":
{ Args: { "p_community_id": string,"p_intent_id": string,"p_kind": string }; Returns: Json
                           },
"require_current_membership":
{ Args: { "p_administrator"?: boolean,"p_community_id": string }; Returns: undefined
                           },
"retry_notification":
{ Args: { "p_intent_id": string,"p_outbox_id": string }; Returns: Json
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "graphql_public": {
          Enums: {

          }
        },"public": {
          Enums: {

          }
        }
} as const
