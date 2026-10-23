-- 130 — IR Builder state templates (2026-10-23, owner-approved spec).
--
-- A new IR file starts from the Property Master File template of its STATE: NT -> Darwin,
-- VIC -> Melbourne, QLD and every other or unknown state -> General. Each template carries its
-- cashflow line defaults (the workbook's "5e - IR Cashflow" values), the Preliminary DD starting
-- rating (Melbourne only: Review; General and Darwin keep the blank start), the strata DD meeting frequency ("5d - Strata DD Report" C11) and,
-- for Darwin, the body-corporate sentence prefilled once into blank strata DD notes.
--
-- Data only: one new row in the existing public.ir_config table (no new table, so no new GRANTs;
-- ir_config keeps its RLS from 104/107). tools/ir-builder.html carries an identical fallback
-- constant (IR_TEMPLATES_FALLBACK) for when this row is missing.
--
-- Files made before this have no setup.template and keep the shared 'defaults' row, which this
-- migration does NOT change. Re-running is safe (upsert on the key).
-- Rollback: delete from public.ir_config where key = 'state_templates';
insert into public.ir_config (key, payload)
values ('state_templates', $json$
{
  "map": {
    "NT": "darwin",
    "VIC": "melbourne"
  },
  "fallback": "general",
  "labels": {
    "maintenanceAllowance": "Maintenance Allowance",
    "minRentalStdCost": "Minimum Rental Standards Compliance",
    "cosmeticWorks": "Cosmetic Works Allowance",
    "titleTransfer": "Mortgage and Title Transfer Fee",
    "conveyancing": "Conveyancing/Legal",
    "buildingPest": "Building and Pest Inspection Reports",
    "minRentalStdReport": "Minimum Rental Standards Compliance Report",
    "depreciationSchedule": "Depreciation Schedule",
    "professionalClean": "Professional Clean",
    "rentalComplianceChecks": "Rental Compliance Checks (Report Only)",
    "councilWater": "Council and Water Rates",
    "insurance": "Insurance Estimate"
  },
  "templates": {
    "general": {
      "label": "General",
      "ddStartRating": null,
      "strata": {
        "meetingFrequency": "Monthly"
      },
      "cashflow": {
        "maintenanceAllowance": 10000,
        "minRentalStdCost": 0,
        "cosmeticWorks": 0,
        "titleTransfer": 1700,
        "conveyancing": 2000,
        "buildingPest": 660,
        "minRentalStdReport": 0,
        "depreciationSchedule": 900,
        "professionalClean": 900,
        "rentalComplianceChecks": 0,
        "councilWater": 3500,
        "insurance": null
      }
    },
    "darwin": {
      "label": "Darwin",
      "ddStartRating": null,
      "strata": {
        "meetingFrequency": "Annually",
        "notes": "To Be confirmed during body corporate inspection clause"
      },
      "cashflow": {
        "maintenanceAllowance": 10000,
        "minRentalStdCost": 0,
        "cosmeticWorks": 0,
        "titleTransfer": 362,
        "conveyancing": 2500,
        "buildingPest": 750,
        "minRentalStdReport": 0,
        "depreciationSchedule": 900,
        "professionalClean": 900,
        "rentalComplianceChecks": 0,
        "councilWater": 3500,
        "insurance": 500
      }
    },
    "melbourne": {
      "label": "Melbourne",
      "ddStartRating": "Review",
      "strata": {
        "meetingFrequency": "Monthly"
      },
      "cashflow": {
        "maintenanceAllowance": 10000,
        "minRentalStdCost": 2000,
        "cosmeticWorks": 0,
        "titleTransfer": 1700,
        "conveyancing": 3200,
        "buildingPest": 660,
        "minRentalStdReport": 550,
        "depreciationSchedule": 900,
        "professionalClean": 900,
        "rentalComplianceChecks": 400,
        "councilWater": 3500,
        "insurance": null
      }
    }
  }
}
$json$::jsonb)
on conflict (key) do update set payload = excluded.payload;
