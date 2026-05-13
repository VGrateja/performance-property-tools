-- =============================================================================
-- 013_cadence_more_boards.sql — Four more Cadence boards
--
-- Seeds the boards that came up most often in scoping conversations:
--   - Maintenance      (repair/inspection requests)
--   - Compliance       (regulatory certificates: smoke/gas/electrical/pool)
--   - Onboarding       (new property onboarding pipeline)
--   - Marketing        (PM requests for photos/floor plans/etc.)
--
-- Field schemas were drafted to balance "enough detail to be useful" with
-- "few enough fields that a PM will actually fill them in". Easy to tweak
-- via the admin gear once you've used them for a few real tasks.
--
-- Each board's "Completed" stage carries is_completion=true, which is
-- what stamps cards.completed_at and fires the completion email.
--
-- Run order: after 012_cadence_assignees.sql. Idempotent
-- (on conflict (slug) do nothing) — re-running is safe but won't
-- reset fields you've since edited via the admin UI.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- MAINTENANCE
-- ---------------------------------------------------------------------------
insert into public.cadence_boards (slug, name, icon, description, display_order, schema)
values (
  'maintenance',
  'Maintenance',
  '🔧',
  'Repair + inspection requests. PM logs the issue; PH Team chases quotes, schedules tradies, and tracks completion.',
  20,
  $json${
    "fields": [
      { "key": "property_address",   "label": "Property Address",     "type": "text",     "kind": "data", "required": true },
      { "key": "property_manager",   "label": "Property Manager",     "type": "text",     "kind": "data", "required": true },
      { "key": "state",              "label": "State",                "type": "select",   "kind": "data", "options": ["NSW","VIC","QLD","SA","WA","TAS","ACT","NT"], "required": true },
      { "key": "priority",           "label": "Priority",             "type": "select",   "kind": "data", "options": ["Urgent","High","Normal","Low"], "required": true },
      { "key": "issue_type",         "label": "Issue Type",           "type": "select",   "kind": "data", "options": ["Plumbing","Electrical","Heating/Cooling","Appliance","Building","Pest","Other"] },
      { "key": "description",        "label": "Description",          "type": "textarea", "kind": "data", "required": true },
      { "key": "tenant_contact",     "label": "Tenant Contact",       "type": "text",     "kind": "data" },
      { "key": "date_reported",      "label": "Date Reported",        "type": "date",     "kind": "data" },
      { "key": "estimated_cost",     "label": "Estimated Cost",       "type": "number",   "kind": "data", "prefix": "$" },

      { "key": "tradie_quoted",      "label": "Tradie Quoted",        "type": "checkbox", "kind": "stage" },
      { "key": "quote_approved",     "label": "Quote Approved",       "type": "checkbox", "kind": "stage" },
      { "key": "work_scheduled",     "label": "Work Scheduled",       "type": "checkbox", "kind": "stage" },
      { "key": "work_completed",     "label": "Work Completed",       "type": "checkbox", "kind": "stage" },
      { "key": "invoice_paid",       "label": "Invoice Paid",         "type": "checkbox", "kind": "stage" },
      { "key": "tenant_notified",    "label": "Tenant Notified",      "type": "checkbox", "kind": "stage" },
      { "key": "completed",          "label": "Completed",            "type": "checkbox", "kind": "stage", "is_completion": true }
    ]
  }$json$::jsonb
)
on conflict (slug) do nothing;


-- ---------------------------------------------------------------------------
-- COMPLIANCE
-- ---------------------------------------------------------------------------
insert into public.cadence_boards (slug, name, icon, description, display_order, schema)
values (
  'compliance',
  'Compliance',
  '🛡️',
  'Regulatory inspections + certificates. Tracks due dates, inspectors, and certificate filing.',
  30,
  $json${
    "fields": [
      { "key": "property_address",   "label": "Property Address",     "type": "text",     "kind": "data", "required": true },
      { "key": "property_manager",   "label": "Property Manager",     "type": "text",     "kind": "data", "required": true },
      { "key": "state",              "label": "State",                "type": "select",   "kind": "data", "options": ["NSW","VIC","QLD","SA","WA","TAS","ACT","NT"], "required": true },
      { "key": "compliance_type",    "label": "Compliance Type",      "type": "select",   "kind": "data", "options": ["Smoke Alarm","Gas Safety","Electrical Safety","Pool Fence","Pest Inspection","Other"], "required": true },
      { "key": "due_date",           "label": "Due Date",             "type": "date",     "kind": "data", "required": true },
      { "key": "inspector_name",     "label": "Inspector",            "type": "text",     "kind": "data" },
      { "key": "cost",               "label": "Cost",                 "type": "number",   "kind": "data", "prefix": "$" },
      { "key": "notes",              "label": "Notes",                "type": "textarea", "kind": "data" },

      { "key": "inspection_booked",  "label": "Inspection Booked",    "type": "checkbox", "kind": "stage" },
      { "key": "inspection_done",    "label": "Inspection Completed", "type": "checkbox", "kind": "stage" },
      { "key": "certificate_recvd",  "label": "Certificate Received", "type": "checkbox", "kind": "stage" },
      { "key": "filed_in_records",   "label": "Filed in Records",     "type": "checkbox", "kind": "stage" },
      { "key": "tenant_notified",    "label": "Tenant Notified",      "type": "checkbox", "kind": "stage" },
      { "key": "completed",          "label": "Completed",            "type": "checkbox", "kind": "stage", "is_completion": true }
    ]
  }$json$::jsonb
)
on conflict (slug) do nothing;


-- ---------------------------------------------------------------------------
-- ONBOARDING
-- ---------------------------------------------------------------------------
insert into public.cadence_boards (slug, name, icon, description, display_order, schema)
values (
  'onboarding',
  'Onboarding',
  '🚪',
  'New property onboarding pipeline. Authority signed → keys received → marketed → tenanted → first rent in.',
  40,
  $json${
    "fields": [
      { "key": "property_address",   "label": "Property Address",     "type": "text",     "kind": "data", "required": true },
      { "key": "property_manager",   "label": "Property Manager",     "type": "text",     "kind": "data", "required": true },
      { "key": "owner_name",         "label": "Owner Name",           "type": "text",     "kind": "data", "required": true },
      { "key": "owner_email",        "label": "Owner Email",          "type": "text",     "kind": "data" },
      { "key": "owner_phone",        "label": "Owner Phone",          "type": "text",     "kind": "data" },
      { "key": "state",              "label": "State",                "type": "select",   "kind": "data", "options": ["NSW","VIC","QLD","SA","WA","TAS","ACT","NT"], "required": true },
      { "key": "property_type",      "label": "Property Type",        "type": "select",   "kind": "data", "options": ["House","Apartment","Townhouse","Unit","Other"] },
      { "key": "management_start",   "label": "Management Start Date","type": "date",     "kind": "data" },
      { "key": "weekly_rent",        "label": "Weekly Rent",          "type": "number",   "kind": "data", "prefix": "$" },
      { "key": "management_fee_pct", "label": "Management Fee %",     "type": "number",   "kind": "data" },
      { "key": "notes",              "label": "Notes",                "type": "textarea", "kind": "data" },

      { "key": "authority_signed",   "label": "Authority Form Signed","type": "checkbox", "kind": "stage" },
      { "key": "keys_received",      "label": "Keys Received",        "type": "checkbox", "kind": "stage" },
      { "key": "initial_inspection", "label": "Initial Inspection",   "type": "checkbox", "kind": "stage" },
      { "key": "photos_taken",       "label": "Photos Taken",         "type": "checkbox", "kind": "stage" },
      { "key": "listing_published",  "label": "Listing Published",    "type": "checkbox", "kind": "stage" },
      { "key": "tenant_found",       "label": "Tenant Found",         "type": "checkbox", "kind": "stage" },
      { "key": "lease_signed",       "label": "Lease Signed",         "type": "checkbox", "kind": "stage" },
      { "key": "first_rent_paid",    "label": "First Rent Paid",      "type": "checkbox", "kind": "stage" },
      { "key": "completed",          "label": "Completed",            "type": "checkbox", "kind": "stage", "is_completion": true }
    ]
  }$json$::jsonb
)
on conflict (slug) do nothing;


-- ---------------------------------------------------------------------------
-- MARKETING REQUESTS
-- ---------------------------------------------------------------------------
insert into public.cadence_boards (slug, name, icon, description, display_order, schema)
values (
  'marketing',
  'Marketing Requests',
  '📣',
  'PM requests for marketing materials — photography, floor plans, video, social.',
  50,
  $json${
    "fields": [
      { "key": "property_address",   "label": "Property Address",     "type": "text",     "kind": "data", "required": true },
      { "key": "property_manager",   "label": "Property Manager",     "type": "text",     "kind": "data", "required": true },
      { "key": "state",              "label": "State",                "type": "select",   "kind": "data", "options": ["NSW","VIC","QLD","SA","WA","TAS","ACT","NT"], "required": true },
      { "key": "request_type",       "label": "Request Type",         "type": "select",   "kind": "data", "options": ["Photography","Floor Plan","Video","Drone","Virtual Tour","Brochure","Social Media","Other"], "required": true },
      { "key": "urgency",            "label": "Urgency",              "type": "select",   "kind": "data", "options": ["ASAP","This week","Within 2 weeks","Flexible"] },
      { "key": "description",        "label": "Description",          "type": "textarea", "kind": "data", "required": true },
      { "key": "vendor_approval",    "label": "Vendor Has Approved",  "type": "checkbox", "kind": "data" },

      { "key": "quote_requested",    "label": "Quote Requested",      "type": "checkbox", "kind": "stage" },
      { "key": "quote_approved",     "label": "Quote Approved",       "type": "checkbox", "kind": "stage" },
      { "key": "vendor_briefed",     "label": "Vendor Briefed",       "type": "checkbox", "kind": "stage" },
      { "key": "shoot_completed",    "label": "Shoot Completed",      "type": "checkbox", "kind": "stage" },
      { "key": "files_received",     "label": "Files Received",       "type": "checkbox", "kind": "stage" },
      { "key": "listing_updated",    "label": "Listing Updated",      "type": "checkbox", "kind": "stage" },
      { "key": "completed",          "label": "Completed",            "type": "checkbox", "kind": "stage", "is_completion": true }
    ]
  }$json$::jsonb
)
on conflict (slug) do nothing;
