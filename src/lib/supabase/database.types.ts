
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
            "allocation_settings": {
                  Row: {
                    "acknowledgment_window": string,"singleton": boolean
                  }
                  ComputedFields: never
                  Insert: {
                    "acknowledgment_window"?: string,"singleton"?: boolean
                  }
                  Update: {
                    "acknowledgment_window"?: string,"singleton"?: boolean
                  }
                  Relationships: [

                  ]
                },"billing_accounts": {
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
                },"borrow_requests": {
                  Row: {
                    "borrower_id": string,"community_id": string,"created_at": string,"decided_at": string | null,"ends_on": string,"exchange_id": string | null,"id": string,"listing_id": string,"owner_id": string,"starts_on": string,"status": string,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "borrower_id": string,"community_id": string,"created_at"?: string,"decided_at"?: string | null,"ends_on": string,"exchange_id"?: string | null,"id"?: string,"listing_id": string,"owner_id": string,"starts_on": string,"status"?: string,"version"?: number
                  }
                  Update: {
                    "borrower_id"?: string,"community_id"?: string,"created_at"?: string,"decided_at"?: string | null,"ends_on"?: string,"exchange_id"?: string | null,"id"?: string,"listing_id"?: string,"owner_id"?: string,"starts_on"?: string,"status"?: string,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "borrow_requests_community_id_fkey"
      columns: ["community_id"]
isOneToOne: false
      referencedRelation: "communities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "borrow_requests_exchange_id_fkey"
      columns: ["exchange_id"]
isOneToOne: true
      referencedRelation: "exchanges"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "borrow_requests_listing_id_community_id_fkey"
      columns: ["listing_id","community_id"]
isOneToOne: false
      referencedRelation: "listings"
      referencedColumns: ["id","community_id"]
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
                },"conversations": {
                  Row: {
                    "community_id": string,"created_at": string,"id": string,"participant_high": string,"participant_low": string,"started_by": string
                  }
                  ComputedFields: never
                  Insert: {
                    "community_id": string,"created_at"?: string,"id"?: string,"participant_high": string,"participant_low": string,"started_by": string
                  }
                  Update: {
                    "community_id"?: string,"created_at"?: string,"id"?: string,"participant_high"?: string,"participant_low"?: string,"started_by"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "conversations_community_id_fkey"
      columns: ["community_id"]
isOneToOne: false
      referencedRelation: "communities"
      referencedColumns: ["id"]
    }
                  ]
                },"exchange_events": {
                  Row: {
                    "actor_id": string | null,"community_id": string,"created_at": string,"exchange_id": string,"id": string,"kind": string
                  }
                  ComputedFields: never
                  Insert: {
                    "actor_id"?: string | null,"community_id": string,"created_at"?: string,"exchange_id": string,"id"?: string,"kind": string
                  }
                  Update: {
                    "actor_id"?: string | null,"community_id"?: string,"created_at"?: string,"exchange_id"?: string,"id"?: string,"kind"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "exchange_events_community_id_fkey"
      columns: ["community_id"]
isOneToOne: false
      referencedRelation: "communities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "exchange_events_exchange_id_fkey"
      columns: ["exchange_id"]
isOneToOne: false
      referencedRelation: "exchanges"
      referencedColumns: ["id"]
    }
                  ]
                },"exchanges": {
                  Row: {
                    "community_id": string,"created_at": string,"id": string,"kind": string,"provider_id": string,"receiver_id": string,"source_id": string,"source_kind": string,"state": string
                  }
                  ComputedFields: never
                  Insert: {
                    "community_id": string,"created_at"?: string,"id"?: string,"kind": string,"provider_id": string,"receiver_id": string,"source_id": string,"source_kind": string,"state": string
                  }
                  Update: {
                    "community_id"?: string,"created_at"?: string,"id"?: string,"kind"?: string,"provider_id"?: string,"receiver_id"?: string,"source_id"?: string,"source_kind"?: string,"state"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "exchanges_community_id_fkey"
      columns: ["community_id"]
isOneToOne: false
      referencedRelation: "communities"
      referencedColumns: ["id"]
    }
                  ]
                },"help_commitments": {
                  Row: {
                    "community_id": string,"created_at": string,"decided_at": string | null,"exchange_id": string | null,"id": string,"listing_id": string | null,"member_id": string,"need_post_id": string | null,"note": string,"status": string
                  }
                  ComputedFields: never
                  Insert: {
                    "community_id": string,"created_at"?: string,"decided_at"?: string | null,"exchange_id"?: string | null,"id"?: string,"listing_id"?: string | null,"member_id": string,"need_post_id"?: string | null,"note"?: string,"status"?: string
                  }
                  Update: {
                    "community_id"?: string,"created_at"?: string,"decided_at"?: string | null,"exchange_id"?: string | null,"id"?: string,"listing_id"?: string | null,"member_id"?: string,"need_post_id"?: string | null,"note"?: string,"status"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "help_commitments_community_id_fkey"
      columns: ["community_id"]
isOneToOne: false
      referencedRelation: "communities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "help_commitments_exchange_id_fkey"
      columns: ["exchange_id"]
isOneToOne: true
      referencedRelation: "exchanges"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "help_commitments_listing_id_community_id_fkey"
      columns: ["listing_id","community_id"]
isOneToOne: false
      referencedRelation: "help_listings"
      referencedColumns: ["id","community_id"]
    },{
      foreignKeyName: "help_commitments_need_post_id_community_id_fkey"
      columns: ["need_post_id","community_id"]
isOneToOne: false
      referencedRelation: "help_need_posts"
      referencedColumns: ["id","community_id"]
    }
                  ]
                },"help_exchange_details": {
                  Row: {
                    "cancel_reason": string | null,"cancelled_at": string | null,"cancelled_by": string | null,"commitment_id": string,"community_id": string,"created_at": string,"duration_minutes": number | null,"exchange_id": string,"meeting_point": string | null,"scheduled_at": string | null,"scheduled_by": string | null,"slot_id": string | null,"starts_at": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "cancel_reason"?: string | null,"cancelled_at"?: string | null,"cancelled_by"?: string | null,"commitment_id": string,"community_id": string,"created_at"?: string,"duration_minutes"?: number | null,"exchange_id": string,"meeting_point"?: string | null,"scheduled_at"?: string | null,"scheduled_by"?: string | null,"slot_id"?: string | null,"starts_at"?: string | null
                  }
                  Update: {
                    "cancel_reason"?: string | null,"cancelled_at"?: string | null,"cancelled_by"?: string | null,"commitment_id"?: string,"community_id"?: string,"created_at"?: string,"duration_minutes"?: number | null,"exchange_id"?: string,"meeting_point"?: string | null,"scheduled_at"?: string | null,"scheduled_by"?: string | null,"slot_id"?: string | null,"starts_at"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "help_exchange_details_commitment_id_fkey"
      columns: ["commitment_id"]
isOneToOne: true
      referencedRelation: "help_commitments"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "help_exchange_details_community_id_fkey"
      columns: ["community_id"]
isOneToOne: false
      referencedRelation: "communities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "help_exchange_details_exchange_id_fkey"
      columns: ["exchange_id"]
isOneToOne: true
      referencedRelation: "exchanges"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "help_exchange_details_slot_id_fkey"
      columns: ["slot_id"]
isOneToOne: true
      referencedRelation: "help_slots"
      referencedColumns: ["id"]
    }
                  ]
                },"help_listings": {
                  Row: {
                    "availability": string,"category": string,"community_id": string,"created_at": string,"description": string,"geographic_constraints": string,"id": string,"owner_id": string,"scheduling_preferences": string,"skill": string,"skill_level": string,"status": string,"title": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "availability": string,"category": string,"community_id": string,"created_at"?: string,"description"?: string,"geographic_constraints": string,"id"?: string,"owner_id": string,"scheduling_preferences"?: string,"skill": string,"skill_level": string,"status"?: string,"title": string,"updated_at"?: string
                  }
                  Update: {
                    "availability"?: string,"category"?: string,"community_id"?: string,"created_at"?: string,"description"?: string,"geographic_constraints"?: string,"id"?: string,"owner_id"?: string,"scheduling_preferences"?: string,"skill"?: string,"skill_level"?: string,"status"?: string,"title"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "help_listings_community_id_fkey"
      columns: ["community_id"]
isOneToOne: false
      referencedRelation: "communities"
      referencedColumns: ["id"]
    }
                  ]
                },"help_need_posts": {
                  Row: {
                    "category": string,"community_id": string,"created_at": string,"description": string,"duration_minutes": number,"helpers_needed": number,"id": string,"location": string,"owner_id": string,"starts_at": string,"status": string,"title": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "category": string,"community_id": string,"created_at"?: string,"description"?: string,"duration_minutes": number,"helpers_needed": number,"id"?: string,"location": string,"owner_id": string,"starts_at": string,"status"?: string,"title": string,"updated_at"?: string
                  }
                  Update: {
                    "category"?: string,"community_id"?: string,"created_at"?: string,"description"?: string,"duration_minutes"?: number,"helpers_needed"?: number,"id"?: string,"location"?: string,"owner_id"?: string,"starts_at"?: string,"status"?: string,"title"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "help_need_posts_community_id_fkey"
      columns: ["community_id"]
isOneToOne: false
      referencedRelation: "communities"
      referencedColumns: ["id"]
    }
                  ]
                },"help_slots": {
                  Row: {
                    "closed_at": string | null,"community_id": string,"created_at": string,"exchange_id": string,"helper_id": string,"id": string,"need_post_id": string,"place": number,"status": string
                  }
                  ComputedFields: never
                  Insert: {
                    "closed_at"?: string | null,"community_id": string,"created_at"?: string,"exchange_id": string,"helper_id": string,"id"?: string,"need_post_id": string,"place": number,"status"?: string
                  }
                  Update: {
                    "closed_at"?: string | null,"community_id"?: string,"created_at"?: string,"exchange_id"?: string,"helper_id"?: string,"id"?: string,"need_post_id"?: string,"place"?: number,"status"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "help_slots_exchange_id_fkey"
      columns: ["exchange_id"]
isOneToOne: true
      referencedRelation: "exchanges"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "help_slots_need_post_id_community_id_fkey"
      columns: ["need_post_id","community_id"]
isOneToOne: false
      referencedRelation: "help_need_posts"
      referencedColumns: ["id","community_id"]
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
                },"item_reservations": {
                  Row: {
                    "acknowledged_at": string | null,"acknowledgment_due_at": string,"blocking": boolean,"condition": string,"created_at": string,"custody_unresolved": boolean,"dates": unknown,"ends_on": string,"exchange_id": string,"lending_conditions": string,"listing_id": string,"replacement_value": number,"request_id": string,"starts_on": string
                  }
                  ComputedFields: never
                  Insert: {
                    "acknowledged_at"?: string | null,"acknowledgment_due_at": string,"blocking"?: boolean,"condition": string,"created_at"?: string,"custody_unresolved"?: boolean,"dates"?: never,"ends_on": string,"exchange_id": string,"lending_conditions": string,"listing_id": string,"replacement_value": number,"request_id": string,"starts_on": string
                  }
                  Update: {
                    "acknowledged_at"?: string | null,"acknowledgment_due_at"?: string,"blocking"?: boolean,"condition"?: string,"created_at"?: string,"custody_unresolved"?: boolean,"dates"?: never,"ends_on"?: string,"exchange_id"?: string,"lending_conditions"?: string,"listing_id"?: string,"replacement_value"?: number,"request_id"?: string,"starts_on"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "item_reservations_exchange_id_fkey"
      columns: ["exchange_id"]
isOneToOne: true
      referencedRelation: "exchanges"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "item_reservations_listing_id_fkey"
      columns: ["listing_id"]
isOneToOne: false
      referencedRelation: "listings"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "item_reservations_request_id_fkey"
      columns: ["request_id"]
isOneToOne: true
      referencedRelation: "borrow_requests"
      referencedColumns: ["id"]
    }
                  ]
                },"listing_availability": {
                  Row: {
                    "dates": unknown,"ends_on": string,"id": string,"listing_id": string,"starts_on": string
                  }
                  ComputedFields: never
                  Insert: {
                    "dates"?: never,"ends_on": string,"id"?: string,"listing_id": string,"starts_on": string
                  }
                  Update: {
                    "dates"?: never,"ends_on"?: string,"id"?: string,"listing_id"?: string,"starts_on"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "listing_availability_listing_id_fkey"
      columns: ["listing_id"]
isOneToOne: false
      referencedRelation: "listings"
      referencedColumns: ["id"]
    }
                  ]
                },"item_need_images": {
                  Row: {
                    "byte_size": number,"created_at": string,"id": string,"need_id": string,"mime_type": string,"object_path": string,"state": string
                  }
                  ComputedFields: never
                  Insert: {
                    "byte_size"?: number,"created_at"?: string,"id"?: string,"need_id"?: string,"mime_type"?: string,"object_path"?: string,"state"?: string
                  }
                  Update: {
                    "byte_size"?: number,"created_at"?: string,"id"?: string,"need_id"?: string,"mime_type"?: string,"object_path"?: string,"state"?: string
                  }
                  Relationships: []
                },"item_need_posts": {
                  Row: {
                    "author_id": string,"category": string,"community_id": string,"created_at": string,"description": string,"ends_on": string,"id": string,"starts_on": string,"status": string,"title": string,"updated_at": string,"urgency": string,"value_max": number | null,"value_min": number | null,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "author_id"?: string,"category"?: string,"community_id"?: string,"created_at"?: string,"description"?: string,"ends_on"?: string,"id"?: string,"starts_on"?: string,"status"?: string,"title"?: string,"updated_at"?: string,"urgency"?: string,"value_max"?: number | null,"value_min"?: number | null,"version"?: number
                  }
                  Update: {
                    "author_id"?: string,"category"?: string,"community_id"?: string,"created_at"?: string,"description"?: string,"ends_on"?: string,"id"?: string,"starts_on"?: string,"status"?: string,"title"?: string,"updated_at"?: string,"urgency"?: string,"value_max"?: number | null,"value_min"?: number | null,"version"?: number
                  }
                  Relationships: []
                },"item_need_responses": {
                  Row: {
                    "community_id": string,"created_at": string,"id": string,"listing_id": string,"need_id": string,"note": string,"responder_id": string,"status": string,"withdrawn_at": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "community_id"?: string,"created_at"?: string,"id"?: string,"listing_id"?: string,"need_id"?: string,"note"?: string,"responder_id"?: string,"status"?: string,"withdrawn_at"?: string | null
                  }
                  Update: {
                    "community_id"?: string,"created_at"?: string,"id"?: string,"listing_id"?: string,"need_id"?: string,"note"?: string,"responder_id"?: string,"status"?: string,"withdrawn_at"?: string | null
                  }
                  Relationships: []
                },"listing_images": {
                  Row: {
                    "byte_size": number,"created_at": string,"id": string,"listing_id": string,"mime_type": string,"object_path": string,"state": string
                  }
                  ComputedFields: never
                  Insert: {
                    "byte_size": number,"created_at"?: string,"id": string,"listing_id": string,"mime_type": string,"object_path": string,"state"?: string
                  }
                  Update: {
                    "byte_size"?: number,"created_at"?: string,"id"?: string,"listing_id"?: string,"mime_type"?: string,"object_path"?: string,"state"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "listing_images_listing_id_fkey"
      columns: ["listing_id"]
isOneToOne: false
      referencedRelation: "listings"
      referencedColumns: ["id"]
    }
                  ]
                },"listings": {
                  Row: {
                    "category": string,"community_id": string,"condition": string,"created_at": string,"description": string,"gratitude": string,"id": string,"lending_conditions": string,"minimum_score": number,"owner_id": string,"pickup_notes": string,"replacement_value": number,"status": string,"title": string,"type": string,"updated_at": string,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "category": string,"community_id": string,"condition": string,"created_at"?: string,"description": string,"gratitude"?: string,"id"?: string,"lending_conditions": string,"minimum_score": number,"owner_id": string,"pickup_notes": string,"replacement_value": number,"status"?: string,"title": string,"type"?: string,"updated_at"?: string,"version"?: number
                  }
                  Update: {
                    "category"?: string,"community_id"?: string,"condition"?: string,"created_at"?: string,"description"?: string,"gratitude"?: string,"id"?: string,"lending_conditions"?: string,"minimum_score"?: number,"owner_id"?: string,"pickup_notes"?: string,"replacement_value"?: number,"status"?: string,"title"?: string,"type"?: string,"updated_at"?: string,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "listings_community_id_fkey"
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
                },"message_selection_grants": {
                  Row: {
                    "conversation_id": string,"dispute_id": string,"ends_at": string | null,"granted_at": string,"id": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "conversation_id": string,"dispute_id": string,"ends_at"?: string | null,"granted_at"?: string,"id"?: string,"user_id": string
                  }
                  Update: {
                    "conversation_id"?: string,"dispute_id"?: string,"ends_at"?: string | null,"granted_at"?: string,"id"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "message_selection_grants_conversation_id_fkey"
      columns: ["conversation_id"]
isOneToOne: false
      referencedRelation: "conversations"
      referencedColumns: ["id"]
    }
                  ]
                },"messages": {
                  Row: {
                    "author_id": string,"body": string,"community_id": string,"conversation_id": string,"created_at": string,"id": string,"intent_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "author_id": string,"body": string,"community_id": string,"conversation_id": string,"created_at"?: string,"id"?: string,"intent_id": string
                  }
                  Update: {
                    "author_id"?: string,"body"?: string,"community_id"?: string,"conversation_id"?: string,"created_at"?: string,"id"?: string,"intent_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "messages_conversation_id_community_id_fkey"
      columns: ["conversation_id","community_id"]
isOneToOne: false
      referencedRelation: "conversations"
      referencedColumns: ["id","community_id"]
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
                },"qualifying_interactions": {
                  Row: {
                    "community_id": string,"created_at": string,"exchange_id": string,"id": string,"participant_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "community_id": string,"created_at"?: string,"exchange_id": string,"id"?: string,"participant_id": string
                  }
                  Update: {
                    "community_id"?: string,"created_at"?: string,"exchange_id"?: string,"id"?: string,"participant_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "qualifying_interactions_community_id_fkey"
      columns: ["community_id"]
isOneToOne: false
      referencedRelation: "communities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "qualifying_interactions_exchange_id_fkey"
      columns: ["exchange_id"]
isOneToOne: false
      referencedRelation: "exchanges"
      referencedColumns: ["id"]
    }
                  ]
                },"reputation_events": {
                  Row: {
                    "community_id": string,"corrects_event_id": string | null,"created_at": string,"exchange_id": string | null,"id": string,"points": number,"reason": string | null,"recipient_id": string,"rule": string,"source_id": string,"source_kind": string,"verified_by": string | null,"verified_by_command": string
                  }
                  ComputedFields: never
                  Insert: {
                    "community_id": string,"corrects_event_id"?: string | null,"created_at"?: string,"exchange_id"?: string | null,"id"?: string,"points": number,"reason"?: string | null,"recipient_id": string,"rule": string,"source_id": string,"source_kind": string,"verified_by"?: string | null,"verified_by_command": string
                  }
                  Update: {
                    "community_id"?: string,"corrects_event_id"?: string | null,"created_at"?: string,"exchange_id"?: string | null,"id"?: string,"points"?: number,"reason"?: string | null,"recipient_id"?: string,"rule"?: string,"source_id"?: string,"source_kind"?: string,"verified_by"?: string | null,"verified_by_command"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "reputation_events_community_id_fkey"
      columns: ["community_id"]
isOneToOne: false
      referencedRelation: "communities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "reputation_events_corrects_event_id_fkey"
      columns: ["corrects_event_id"]
isOneToOne: false
      referencedRelation: "reputation_events"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "reputation_events_exchange_id_fkey"
      columns: ["exchange_id"]
isOneToOne: false
      referencedRelation: "exchanges"
      referencedColumns: ["id"]
    }
                  ]
                },"reputation_rules": {
                  Row: {
                    "exchange_kind": string,"points": number,"recipient_role": string,"rule": string
                  }
                  ComputedFields: never
                  Insert: {
                    "exchange_kind": string,"points": number,"recipient_role": string,"rule": string
                  }
                  Update: {
                    "exchange_kind"?: string,"points"?: number,"recipient_role"?: string,"rule"?: string
                  }
                  Relationships: [

                  ]
                },"reputation_titles": {
                  Row: {
                    "max_score": number,"min_score": number,"title": string
                  }
                  ComputedFields: never
                  Insert: {
                    "max_score": number,"min_score": number,"title": string
                  }
                  Update: {
                    "max_score"?: number,"min_score"?: number,"title"?: string
                  }
                  Relationships: [

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
                },"trust_incidents": {
                  Row: {
                    "community_id": string,"created_at": string,"id": string,"source_id": string,"source_kind": string,"status": string,"subject_id": string,"type": string
                  }
                  ComputedFields: never
                  Insert: {
                    "community_id": string,"created_at"?: string,"id"?: string,"source_id": string,"source_kind": string,"status": string,"subject_id": string,"type": string
                  }
                  Update: {
                    "community_id"?: string,"created_at"?: string,"id"?: string,"source_id"?: string,"source_kind"?: string,"status"?: string,"subject_id"?: string,"type"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "trust_incidents_community_id_fkey"
      columns: ["community_id"]
isOneToOne: false
      referencedRelation: "communities"
      referencedColumns: ["id"]
    }
                  ]
                },"vouch_eligibility": {
                  Row: {
                    "community_id": string,"eligible": boolean,"sponsor_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "community_id": string,"eligible": boolean,"sponsor_id": string
                  }
                  Update: {
                    "community_id"?: string,"eligible"?: boolean,"sponsor_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "vouch_eligibility_community_id_fkey"
      columns: ["community_id"]
isOneToOne: false
      referencedRelation: "communities"
      referencedColumns: ["id"]
    }
                  ]
                },"vouch_requests": {
                  Row: {
                    "applicant_id": string,"application_id": string,"community_id": string,"created_at": string,"id": string,"sponsor_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "applicant_id": string,"application_id": string,"community_id": string,"created_at"?: string,"id"?: string,"sponsor_id": string
                  }
                  Update: {
                    "applicant_id"?: string,"application_id"?: string,"community_id"?: string,"created_at"?: string,"id"?: string,"sponsor_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "vouch_requests_application_id_fkey"
      columns: ["application_id"]
isOneToOne: false
      referencedRelation: "membership_applications"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "vouch_requests_community_id_fkey"
      columns: ["community_id"]
isOneToOne: false
      referencedRelation: "communities"
      referencedColumns: ["id"]
    }
                  ]
                },"vouch_settings": {
                  Row: {
                    "annual_limit": number,"community_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "annual_limit"?: number,"community_id": string
                  }
                  Update: {
                    "annual_limit"?: number,"community_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "vouch_settings_community_id_fkey"
      columns: ["community_id"]
isOneToOne: true
      referencedRelation: "communities"
      referencedColumns: ["id"]
    }
                  ]
                },"vouches": {
                  Row: {
                    "applicant_id": string,"application_id": string,"community_id": string,"created_at": string,"event_id": string,"id": string,"sponsor_id": string,"statement": string
                  }
                  ComputedFields: never
                  Insert: {
                    "applicant_id": string,"application_id": string,"community_id": string,"created_at"?: string,"event_id": string,"id"?: string,"sponsor_id": string,"statement": string
                  }
                  Update: {
                    "applicant_id"?: string,"application_id"?: string,"community_id"?: string,"created_at"?: string,"event_id"?: string,"id"?: string,"sponsor_id"?: string,"statement"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "vouches_application_id_fkey"
      columns: ["application_id"]
isOneToOne: false
      referencedRelation: "membership_applications"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "vouches_community_id_fkey"
      columns: ["community_id"]
isOneToOne: false
      referencedRelation: "communities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "vouches_event_id_fkey"
      columns: ["event_id"]
isOneToOne: true
      referencedRelation: "community_events"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "accept_help_commitment":
{ Args: { "p_commitment_id": string,"p_intent_id": string }; Returns: Json
                           },
"can_read_conversation":
{ Args: { "p_conversation_id": string,"p_message_at"?: string }; Returns: boolean
                           },
"can_read_exchange":
{ Args: { "p_exchange_id": string }; Returns: boolean
                           },
"can_read_help_commitment":
{ Args: { "p_commitment_id": string }; Returns: boolean
                           },
"can_read_invite":
{ Args: { "p_invite_id": string }; Returns: boolean
                           },
"cancel_help_exchange":
{ Args: { "p_exchange_id": string,"p_intent_id": string,"p_reason": string }; Returns: Json
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
"commit_help":
{ Args: { "p_intent_id": string,"p_note"?: string,"p_post_id": string,"p_post_kind": string }; Returns: Json
                           },
"complete_listing_image":
{ Args: { "p_image_id": string,"p_intent_id": string }; Returns: Json
                           },
"configure_vouch":
{ Args: { "p_annual_limit": number,"p_community_id": string,"p_eligible": boolean,"p_intent_id": string,"p_sponsor_id": string }; Returns: Json
                           },
"conversation_candidates":
{ Args: { "p_community_id": string }; Returns: {
              "email": string,"user_id": string
            }[]
                           },
"conversation_inbox":
{ Args: Record<PropertyKey, never>; Returns: {
              "can_send": boolean,"community_id": string,"community_name": string,"counterpart_email": string,"counterpart_id": string,"created_at": string,"id": string,"last_message_at": string
            }[]
                           },
"create_community":
{ Args: { "p_description"?: string,"p_intent_id": string,"p_name": string }; Returns: Json
                           },
"create_help_post":
{ Args: { "p_community_id": string,"p_fields": Json,"p_intent_id": string,"p_post_kind": string }; Returns: Json
                           },
"decide_borrow_request":
{ Args: { "p_decision": string,"p_expected_version": number,"p_intent_id": string,"p_request_id": string }; Returns: Json
                           },
"decide_membership":
{ Args: { "p_application_id": string,"p_decision": string,"p_intent_id": string,"p_reason"?: string }; Returns: Json
                           },
"edit_help_post":
{ Args: { "p_fields": Json,"p_intent_id": string,"p_post_id": string,"p_post_kind": string }; Returns: Json
                           },
"expire_due_item_approvals":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"expire_item_approval":
{ Args: { "p_exchange_id": string }; Returns: Json
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
"global_trust":
{ Args: { "p_subject": string }; Returns: Json
                           },
"help_board":
{ Args: { "p_category"?: string,"p_community_id": string,"p_post_kind"?: string,"p_search"?: string }; Returns: Json[]
                           },
"help_post":
{ Args: { "p_post_id": string,"p_post_kind": string }; Returns: Json
                           },
"is_active_member":
{ Args: { "target_community": string }; Returns: boolean
                           },
"is_community_administrator":
{ Args: { "p_community_id": string }; Returns: boolean
                           },
"is_eligible_sponsor":
{ Args: { "p_community_id": string }; Returns: boolean
                           },
"issue_invite":
{ Args: { "p_community_id": string,"p_email": string,"p_intent_id": string }; Returns: Json
                           },
"link_test_customer":
{ Args: { "p_claim_token": string,"p_customer_id": string,"p_job_id": string }; Returns: undefined
                           },
"member_directory":
{ Args: { "p_community_id": string }; Returns: {
              "completed_interactions": number,"email": string,"joined_at": string,"role": string,"score": number,"title": string,"user_id": string
            }[]
                           },
"member_profile":
{ Args: { "p_community_id": string,"p_subject": string }; Returns: Json
                           },
"my_help_exchanges":
{ Args: Record<PropertyKey, never>; Returns: Json[]
                           },
"my_reputation":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"my_vouch_statements":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"prepare_listing_image":
{ Args: { "p_byte_size": number,"p_image_id": string,"p_intent_id": string,"p_listing_id": string,"p_mime_type": string }; Returns: Json
                           },
"receive_stripe_receipt":
{ Args: { "p_customer_id": string,"p_event_id": string,"p_event_type": string,"p_fingerprint": string,"p_subscription_id": string }; Returns: Json
                           },
"complete_item_need_image":
{ Args: { "p_image_id": string,"p_intent_id": string }; Returns: Json
                           },
"prepare_item_need_image":
{ Args: { "p_byte_size": number,"p_image_id": string,"p_intent_id": string,"p_mime_type": string,"p_need_id": string }; Returns: Json
                           },
"remove_item_need_image":
{ Args: { "p_image_id": string,"p_intent_id": string }; Returns: Json
                           },
"respond_to_item_need":
{ Args: { "p_intent_id": string,"p_listing_id": string,"p_need_id": string,"p_note"?: string }; Returns: Json
                           },
"save_item_need":
{ Args: { "p_community_id": string,"p_details"?: Json,"p_expected_version"?: number,"p_intent_id": string,"p_need_id"?: string }; Returns: Json
                           },
"withdraw_item_need":
{ Args: { "p_expected_version": number,"p_intent_id": string,"p_need_id": string }; Returns: Json
                           },
"withdraw_item_need_response":
{ Args: { "p_intent_id": string,"p_response_id": string }; Returns: Json
                           },
"redeem_invite":
{ Args: { "p_intent_id": string,"p_invite_id": string }; Returns: Json
                           },
"remove_listing_image":
{ Args: { "p_image_id": string,"p_intent_id": string }; Returns: Json
                           },
"request_test_billing":
{ Args: { "p_community_id": string,"p_intent_id": string,"p_kind": string }; Returns: Json
                           },
"request_vouch":
{ Args: { "p_application_id": string,"p_intent_id": string,"p_sponsor_email": string }; Returns: Json
                           },
"require_current_membership":
{ Args: { "p_administrator"?: boolean,"p_community_id": string }; Returns: undefined
                           },
"retry_notification":
{ Args: { "p_intent_id": string,"p_outbox_id": string }; Returns: Json
                           },
"save_listing":
{ Args: { "p_community_id": string,"p_details"?: Json,"p_expected_version"?: number,"p_intent_id": string,"p_listing_id"?: string }; Returns: Json
                           },
"schedule_help_exchange":
{ Args: { "p_exchange_id": string,"p_fields": Json,"p_intent_id": string }; Returns: Json
                           },
"send_message":
{ Args: { "p_body": string,"p_conversation_id": string,"p_intent_id": string }; Returns: Json
                           },
"settle_exchange_completions":
{ Args: { "p_exchange_ids": (string)[] }; Returns: Json
                           },
"start_conversation":
{ Args: { "p_community_id": string,"p_intent_id": string,"p_participant_id": string }; Returns: Json
                           },
"submit_borrow_request":
{ Args: { "p_ends_on": string,"p_intent_id": string,"p_listing_id": string,"p_starts_on": string }; Returns: Json
                           },
"submit_vouch":
{ Args: { "p_application_id": string,"p_intent_id": string,"p_statement": string }; Returns: Json
                           },
"vouch_workspace":
{ Args: { "p_community_id": string }; Returns: Json
                           },
"withdraw_help_post":
{ Args: { "p_intent_id": string,"p_post_id": string,"p_post_kind": string }; Returns: Json
                           },
"withdraw_listing":
{ Args: { "p_expected_version": number,"p_intent_id": string,"p_listing_id": string }; Returns: Json
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
