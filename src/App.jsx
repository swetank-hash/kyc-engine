import { useState, useCallback, useRef } from "react";

// ─── Fuzzy name matching ───────────────────────────────────────────────────
function fuzzyNameMatch(a = "", b = "") {
  if (!a || !b) return false;
  const clean = s =>
    s.toLowerCase()
      .replace(/\b(mr|mrs|ms|dr|prof|shri|smt|late|m\/s)\b\.?/gi, "")
      .replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  const ca = clean(a), cb = clean(b);
  if (ca === cb) return true;
  if (ca.split(" ").sort().join(" ") === cb.split(" ").sort().join(" ")) return true;
  const wa = ca.split(" "), wb = cb.split(" ");
  return wa.filter(w => wb.includes(w)).length >= Math.min(wa.length, wb.length);
}

// ─── Campaign rules ────────────────────────────────────────────────────────
const CAMPAIGN_ALLOWED = {
  medical:                ["beneficiary","myself","family_member","treating_hospital","vendor"],
  memorial:               ["family_member","myself"],
  memorials:              ["family_member","myself"],
  educational:            ["beneficiary","myself","family_member","educational_institute"],
  education:              ["beneficiary","myself","family_member","educational_institute"],
  organization:           ["ngo"],
  organisation:           ["ngo"],
  hospital_admin:         ["beneficiary","myself","family_member","treating_hospital","vendor"],
  social:                 ["beneficiary","myself","ngo","treating_hospital","vendor"],
  social_entrepreneurship:["beneficiary","myself","ngo","treating_hospital","vendor"],
  media:                  ["beneficiary","myself"],
  animals:                ["beneficiary","myself"],
  emergencies:            ["beneficiary","myself","family_member"],
  sports:                 ["beneficiary","myself"],
  others:                 ["beneficiary","myself","family_member","ngo","treating_hospital","vendor"],
};
const INDIV   = ["beneficiary","myself","family_member"];
const ORG     = ["treating_hospital","vendor","ngo","educational_institute"];
const REL_REQ = ["family_member","treating_hospital","vendor","ngo","educational_institute"];
const norm    = s => (s||"").toLowerCase().replace(/[\s\-]+/g,"_").replace(/[^a-z0-9_]/g,"");

// Normalise recipient type — map aliases to canonical values
function normRecipient(r = "") {
  const n = norm(r);
  const aliases = {
    organisation: "ngo",
    organization: "ngo",
    treating_hospital: "treating_hospital",
    hospital: "treating_hospital",
    family_member: "family_member",
    educational_institute: "educational_institute",
    college: "educational_institute",
    school: "educational_institute",
  };
  return aliases[n] || n;
}

// Parse currency field — handles "{inr,other,usd}", "INR", "USD" etc.
// {inr,other,usd} means campaign accepts multiple currencies — treat as INR
// Only flag USD if currency is exclusively USD (no INR present)
function parseCurrency(raw = "") {
  const s = raw.toLowerCase();
  const hasUSD = s.includes("usd");
  const hasINR = s.includes("inr") || s.includes("other");
  if (hasUSD && !hasINR) return "USD"; // exclusively USD
  return "INR"; // INR or mixed — apply INR rules
}

// ─── Parse pre-computed OCR data from CSV column ──────────────────────────
// Handles formats:
//   Single:   {"name":"Ravi","document_type":"Aadhaar Card","document_id":"1234"}
//   Multiple: {"name":"Ravi",...} , {"name":null,"side":"back",...}
//   Array:    [{"name":"Ravi",...},{"name":null,...}]

function parseOcrColumn(raw = "") {
  if (!raw || raw.trim() === "") return null;

  // Strip outer single quotes if present (some CSV exporters wrap in single quotes)
  raw = raw.trim().replace(/^'+|'+$/g, "").trim();
  // Unescape CSV double-quote escaping ("" → ") if present
  raw = raw.replace(/""/g, '"');

  // ── Step 1: extract individual JSON objects using regex ──────────────────
  // This avoids trying to parse the whole string as JSON at once
  const objectPattern = /\{[^{}]*\}/g;
  const rawObjects = raw.match(objectPattern) || [];

  if (rawObjects.length === 0) return null;

  const entries = [];
  for (const objStr of rawObjects) {
    try {
      entries.push(JSON.parse(objStr));
    } catch {
      // try fixing common issues: single quotes, unquoted nulls
      try {
        const fixed = objStr
          .replace(/'/g, '"')                    // single → double quotes
          .replace(/:\s*None/g, ': null')       // Python None → null
          .replace(/:\s*True/g, ': true')       // Python True → true
          .replace(/:\s*False/g, ': false');    // Python False → false
        entries.push(JSON.parse(fixed));
      } catch { /* skip unparseable object */ }
    }
  }

  if (entries.length === 0) {
    // Last resort: regex extract all name values directly
    const names = [...raw.matchAll(/"name"\s*:\s*"([^"]+)"/g)]
      .map(m => m[1])
      .filter(n => n && n !== "null");
    if (names.length > 0) {
      return { full_name: names[0], names_found: [...new Set(names)], document_type: null, document_number: null, _raw_entries: [] };
    }
    return null;
  }

  // ── Step 2: merge all entries ────────────────────────────────────────────
  const allNames = [];
  const merged = {};

  for (const entry of entries) {
    // collect all non-null names
    const n = entry.name || entry.full_name || entry.account_name || null;
    if (n && n !== "null") allNames.push(n);
    // take first non-null value for each key
    for (const [k, v] of Object.entries(entry)) {
      if (v !== null && v !== undefined && v !== "null" && !merged[k]) merged[k] = v;
    }
  }

  return {
    full_name:       merged.name || merged.full_name || allNames[0] || null,
    document_type:   merged.document_type || null,
    document_number: merged.document_id || merged.document_number || null,
    names_found:     [...new Set(allNames)],
    _raw_entries:    entries,
  };
}

// ─── KYC Engine ────────────────────────────────────────────────────────────
function runKYC(row, ocrResults = {}) {
  const checks = [];
  let decision = "APPROVE";
  const flag = lvl => { if (lvl==="REJECT") decision="REJECT"; else if (lvl==="HOLD" && decision!=="REJECT") decision="HOLD"; };

  const rt         = normRecipient(row.recipient_type||"");
  const cat        = norm(row.category||"");
  const currency   = parseCurrency(row.currency||"INR");
  const isUSD      = currency === "USD";
  const isFCRA     = (row.is_fcra_account||"").toLowerCase()==="yes";
  const acctStatus = (row.account_status||"").toUpperCase();
  const nameBank   = (row.name_as_in_bank||"").trim();
  const nameUser   = (row.account_holder_name||row.name_entered_by_user||"").trim();
  const panStatus  = (row.pan_status||"").toUpperCase();
  const panName    = (row.pan_name||"").trim();
  const recipName  = (row.recipient_name||"").trim();
  const benefName  = (row.beneficiary_name||"").trim();
  const coName     = (row.co_name||"").trim();
  const gstStatus  = (row.gst_status||"").toUpperCase();
  const relProof   = (row.relationship_proof_present||"").toLowerCase();
  const isOrg      = ORG.includes(rt);
  const isIndiv    = INDIV.includes(rt);

  // OCR results
  // Column name aliases — support both naming conventions from real CSV
  if (!row.id_proof_url && row.id_proof_link)             row.id_proof_url = row.id_proof_link;
  if (!row.relationship_proof_url && row.relationship_proof_link) row.relationship_proof_url = row.relationship_proof_link;
  if (!row.account_holder_name && row.name_as_in_bank)    row.account_holder_name = row.name_as_in_bank;
  if (!row.gst_status && row.gstin_valid)                 row.gst_status = row.gstin_valid === "true" || row.gstin_valid === "1" ? "VALID" : (row.gstin_valid || "").toUpperCase();
  if (!row.relationship_type && row.relationship_with_beneficiary) row.relationship_type = row.relationship_with_beneficiary;
  if (!row.recipient_name && row.name_as_in_bank)         row.recipient_name = row.name_as_in_bank;

  // Use pre-computed OCR data from CSV columns if available
  // Falls back to runtime OCR results (ocrResults) if CSV OCR not present
  const idOCR  = (row.id_proof_ocr_data   ? parseOcrColumn(row.id_proof_ocr_data)           : null)
              || ocrResults.id_proof  || null;
  const relOCR = (row.relationship_proof_ocr_data ? parseOcrColumn(row.relationship_proof_ocr_data) : null)
              || ocrResults.rel_proof || null;

  // 1. Account Status
  if (["VERIFIED","VALID"].includes(acctStatus)) {
    checks.push({ id:"acct", label:"Account Status", status:"pass", detail:"Account verified by banking API." });
  } else if (["INVALID","BLOCKED"].includes(acctStatus)) {
    checks.push({ id:"acct", label:"Account Status", status:"reject", detail:"Account is invalid/blocked. User must provide a working bank account and re-raise request." });
    flag("REJECT");
  } else {
    checks.push({ id:"acct", label:"Account Status", status:"hold", detail:"Account could not be authenticated. Assign to calling team for passbook verification (resolve within 2 days)." });
    flag("HOLD");
  }

  // 2. Name Match
  if (nameBank && nameUser) {
    if (fuzzyNameMatch(nameBank, nameUser)) {
      checks.push({ id:"name", label:"Name Match (Bank vs User)", status:"pass", detail:`"${nameUser}" matches bank record "${nameBank}".` });
    } else {
      checks.push({ id:"name", label:"Name Match (Bank vs User)", status:"reject", detail:`Mismatch — user entered "${nameUser}", bank shows "${nameBank}". Update the bank account name.` });
      flag("REJECT");
    }
  } else {
    checks.push({ id:"name", label:"Name Match (Bank vs User)", status:"hold", detail:"Bank name or user-entered name missing. Manual verification required." });
    flag("HOLD");
  }

  // 3. Recipient Type vs Campaign
  const allowed = CAMPAIGN_ALLOWED[cat];
  if (allowed) {
    if (allowed.includes(rt)) {
      checks.push({ id:"rt_cat", label:"Recipient Type vs Campaign", status:"pass", detail:`"${row.recipient_type}" is permitted for "${row.category}" campaigns.` });
    } else {
      checks.push({ id:"rt_cat", label:"Recipient Type vs Campaign", status:"reject", detail:`"${row.recipient_type}" is NOT allowed for "${row.category}" campaigns. Allowed: ${allowed.join(", ")}.` });
      flag("REJECT");
    }
  } else {
    checks.push({ id:"rt_cat", label:"Recipient Type vs Campaign", status:"hold", detail:`Unknown campaign category "${row.category}". Manual review required.` });
    flag("HOLD");
  }

  // 4. Myself — CO name match
  if (rt === "myself") {
    if (coName && (nameUser||nameBank)) {
      // co_name may be a username/handle — only flag mismatch if it looks like a real name
      // A real name has letters and spaces but no digits/underscores dominating
      const looksLikeName = (s) => /^[a-zA-Z\s\.]{4,}$/.test(s.trim());
      if (!looksLikeName(coName)) {
        // co_name is a username/handle — can't reliably match, pass to manual
        checks.push({ id:"myself", label:"CO Name Match (Myself)", status:"hold", detail:`CO identifier "${coName}" appears to be a username, not a name. Manual verification of account ownership required.` });
        flag("HOLD");
      } else if (fuzzyNameMatch(coName,nameUser)||fuzzyNameMatch(coName,nameBank)) {
        checks.push({ id:"myself", label:"CO Name Match (Myself)", status:"pass", detail:`Account holder matches Campaign Organiser "${coName}".` });
      } else {
        checks.push({ id:"myself", label:"CO Name Match (Myself)", status:"reject", detail:`Recipient type is "myself" but account name "${nameUser||nameBank}" doesn't match CO "${coName}".` });
        flag("REJECT");
      }
    } else {
      checks.push({ id:"myself", label:"CO Name Match (Myself)", status:"hold", detail:"CO name unavailable to verify 'myself' recipient. Manual check needed." });
      flag("HOLD");
    }
  }

  // 5. ID Proof — Individual (with OCR)
  if (isIndiv) {
    const idUrl = row.id_proof_url || row.id_proof_1_url || "";
    if (!idUrl && !idOCR) {
      checks.push({ id:"id", label:"ID Proof (Individual)", status:"hold", detail:"No ID proof URL provided in CSV. Add id_proof_url column with the document URL." });
      flag("HOLD");
    } else if (idOCR?.error) {
      checks.push({ id:"id", label:"ID Proof (Individual)", status:"hold", detail:`ID proof error: ${idOCR.error}. Manual review required.` });
      flag("HOLD");
    } else if (idOCR?.full_name) {
      const nameToCheck = rt==="myself" ? (coName||nameUser) : (recipName||nameUser);
      const idMatch     = fuzzyNameMatch(idOCR.full_name, nameToCheck);
      const benMatch    = benefName && fuzzyNameMatch(idOCR.full_name, benefName);
      if (idMatch || benMatch) {
        checks.push({ id:"id", label:"ID Proof (Individual)", status:"pass",
          detail:`${idOCR.document_type||"Document"}${idOCR.document_number?` (${idOCR.document_number})`:""}. Extracted name "${idOCR.full_name}" matches recipient/beneficiary.` });
      } else {
        checks.push({ id:"id", label:"ID Proof (Individual)", status:"reject",
          detail:`Extracted name "${idOCR.full_name}" doesn't match recipient "${nameToCheck}" or beneficiary "${benefName}". Align the recipient name with the document.` });
        flag("REJECT");
      }
    } else if (idOCR) {
      // OCR ran but no name extracted — document may be valid, check doc number at least
      const docNum = idOCR.document_number || "";
      checks.push({ id:"id", label:"ID Proof (Individual)", status:"hold",
        detail:`ID document present${docNum ? ` (${idOCR.document_type||"Doc"}: ${docNum})` : ""} but name could not be extracted. Manual name verification required.` });
      flag("HOLD");
    } else {
      checks.push({ id:"id", label:"ID Proof (Individual)", status:"hold", detail:"ID proof data not available. Manual review required." });
      flag("HOLD");
    }
  }

  // 6. PAN — Org
  if (isOrg) {
    const panUrl = row.pan_url || row.id_proof_url || "";
    if (!panStatus && !panUrl && !idOCR) {
      checks.push({ id:"pan", label:"PAN Verification (Org)", status:"hold", detail:"PAN not submitted. Required for all organisational recipients." });
      flag("HOLD");
    } else if (idOCR?.pan_number || panStatus) {
      const extractedPAN = idOCR?.pan_number || "";
      const pName = idOCR?.full_name || panName;
      const eff   = panStatus || (extractedPAN ? "EXTRACTED" : "");
      if (eff && pName && recipName) {
        if (fuzzyNameMatch(pName, recipName)) {
          checks.push({ id:"pan", label:"PAN Verification (Org)", status:"pass",
            detail:`PAN${extractedPAN?` ${extractedPAN}`:""} — name "${pName}" matches recipient "${recipName}".` });
        } else {
          checks.push({ id:"pan", label:"PAN Verification (Org)", status:"reject",
            detail:`PAN name "${pName}" doesn't match recipient "${recipName}". Update hospital/vendor name.` });
          flag("REJECT");
        }
      } else if (panStatus === "INVALID") {
        checks.push({ id:"pan", label:"PAN Verification (Org)", status:"reject", detail:"PAN is INVALID. Provide correct PAN card details." });
        flag("REJECT");
      } else {
        checks.push({ id:"pan", label:"PAN Verification (Org)", status:"hold", detail:"PAN details partially available. Manual verification required." });
        flag("HOLD");
      }
    } else {
      checks.push({ id:"pan", label:"PAN Verification (Org)", status:"hold", detail:"PAN document data not available. Manual review required." });
      flag("HOLD");
    }
  }

  // 7. GST — Vendor
  if (rt === "vendor") {
    if (!gstStatus) {
      checks.push({ id:"gst", label:"GST Verification (Vendor)", status:"hold", detail:"GST number not submitted. Required for vendor accounts." });
      flag("HOLD");
    } else if (gstStatus === "VALID") {
      checks.push({ id:"gst", label:"GST Verification (Vendor)", status:"pass", detail:"GST number verified as valid." });
    } else {
      checks.push({ id:"gst", label:"GST Verification (Vendor)", status:"reject", detail:"GST verification failed. Vendor must provide a valid GST invoice." });
      flag("REJECT");
    }
  }

  // 8. Relationship Proof (with OCR)
  if (REL_REQ.includes(rt)) {
    const relUrl = row.relationship_proof_url || row.rel_proof_url || "";
    if (!relUrl && !relOCR) {
      checks.push({ id:"rel", label:"Relationship Proof", status:"hold", detail:"No relationship proof URL in CSV. Add relationship_proof_url column." });
      flag("HOLD");
    } else if (relOCR?.error) {
      checks.push({ id:"rel", label:"Relationship Proof", status:"hold", detail:`Relationship proof error: ${relOCR.error}. Manual review required.` });
      flag("HOLD");
    } else if (relOCR?.names_found) {
      const names   = relOCR.names_found || [];
      const hasBenef = benefName && names.some(n => fuzzyNameMatch(n, benefName));
      const hasRecip = recipName && names.some(n => fuzzyNameMatch(n, recipName));
      if (hasBenef && hasRecip) {
        checks.push({ id:"rel", label:"Relationship Proof", status:"pass",
          detail:`${relOCR.document_type||"Document"} — both "${benefName}" (beneficiary) and "${recipName}" (recipient) found in document. Relationship established.` });
      } else if (!hasBenef && !hasRecip) {
        checks.push({ id:"rel", label:"Relationship Proof", status:"reject",
          detail:`Neither beneficiary "${benefName}" nor recipient "${recipName}" found in relationship document. Names found: ${names.join(", ")||"none"}. Provide a valid document.` });
        flag("REJECT");
      } else {
        const missing = !hasBenef ? `beneficiary "${benefName}"` : `recipient "${recipName}"`;
        checks.push({ id:"rel", label:"Relationship Proof", status:"reject",
          detail:`Could not confirm ${missing} in relationship document. Names found: ${names.join(", ")||"none"}.` });
        flag("REJECT");
      }
    } else if (relOCR) {
      checks.push({ id:"rel", label:"Relationship Proof", status:"hold", detail:"Relationship document OCR processed but could not extract names. Manual review required." });
      flag("HOLD");
    } else {
      checks.push({ id:"rel", label:"Relationship Proof", status:"hold", detail:"Relationship proof processing..." });
      flag("HOLD");
    }
  }

  // 9. FCRA / USD
  if (isUSD) {
    if (["media","legal"].includes(cat)) {
      checks.push({ id:"fcra", label:"USD / FCRA Compliance", status:"reject", detail:"Foreign donations are NOT permitted for media/legal campaigns." });
      flag("REJECT");
    } else if (!isFCRA && isIndiv) {
      checks.push({ id:"fcra", label:"USD / FCRA Compliance", status:"reject", detail:"USD cannot be transferred to individual accounts per FCRA guidelines. An FCRA trust account is required." });
      flag("REJECT");
    } else if (!isFCRA && rt==="vendor") {
      if (gstStatus==="VALID") {
        checks.push({ id:"fcra", label:"USD / FCRA Compliance (Vendor)", status:"pass", detail:"Vendor is GST registered — USD transfer permitted." });
      } else {
        checks.push({ id:"fcra", label:"USD / FCRA Compliance (Vendor)", status:"reject", detail:"Foreign donations to vendor accounts require GST registration. GST not verified." });
        flag("REJECT");
      }
    } else if (isFCRA) {
      const ifsc = (row.ifsc_code||"").toUpperCase();
      if (ifsc.startsWith("SBIN")) {
        checks.push({ id:"fcra", label:"USD / FCRA Compliance", status:"pass", detail:"FCRA account confirmed (SBI). USD transfers permitted." });
      } else {
        checks.push({ id:"fcra", label:"USD / FCRA Compliance", status:"hold", detail:"FCRA flag is YES but IFSC is not SBI Main Branch. Verify FCRA account validity." });
        flag("HOLD");
      }
    } else {
      checks.push({ id:"fcra", label:"USD / FCRA Compliance", status:"hold", detail:"USD transfer requested — FCRA status unclear. Manual verification required." });
      flag("HOLD");
    }
  }

  // 10. NGO same-entity
  if (rt==="ngo") {
    const cNGO = (row.campaign_ngo_name||"").trim();
    if (cNGO && recipName && !fuzzyNameMatch(cNGO,recipName)) {
      checks.push({ id:"ngo", label:"NGO Same-Entity Rule", status:"reject", detail:`Campaign is for "${cNGO}" but funds directed to "${recipName}". Funds must go to the same NGO.` });
      flag("REJECT");
    } else if (cNGO) {
      checks.push({ id:"ngo", label:"NGO Same-Entity Rule", status:"pass", detail:"Campaign NGO and recipient NGO match." });
    }
  }

  // 11. Vendor relevance
  if (rt==="vendor" && cat==="medical") {
    const vc = (row.vendor_category||"").toLowerCase();
    if (vc) {
      const medTerms = ["medical","pharmacy","diagnostic","equipment","hospital","clinic","lab","surgical","medicine","drug","health"];
      if (medTerms.some(v=>vc.includes(v))) {
        checks.push({ id:"vrel", label:"Vendor Relevance", status:"pass", detail:`Vendor category "${row.vendor_category}" is relevant to a medical campaign.` });
      } else {
        checks.push({ id:"vrel", label:"Vendor Relevance", status:"reject", detail:`Vendor "${row.vendor_category}" is not relevant to a medical campaign. Vendor must relate to the campaign purpose.` });
        flag("REJECT");
      }
    }
  }

  return { checks, decision };
}

// ─── CSV Parser ────────────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map(h => h.trim().toLowerCase().replace(/\s+/g,"_").replace(/[^a-z0-9_]/g,""));
  return lines.slice(1).filter(l=>l.trim()).map(line => {
    const values = []; let cur = "", inQ = false;
    for (const ch of line) {
      if (ch==='"') inQ=!inQ;
      else if (ch===","&&!inQ) { values.push(cur.trim()); cur=""; }
      else cur+=ch;
    }
    values.push(cur.trim());
    const obj = {};
    headers.forEach((h,i) => { obj[h] = (values[i]||"").replace(/^"|"$/g,"").replace(/""/g,'"').replace(/^'+|'+$/g,"").trim(); });
    return obj;
  });
}

// ─── Design tokens ─────────────────────────────────────────────────────────
const SC = {
  pass:   { color:"#34d399", bg:"#022c1e", label:"PASS", icon:"✓" },
  reject: { color:"#f87171", bg:"#200808", label:"FAIL", icon:"✗" },
  hold:   { color:"#fbbf24", bg:"#1e1506", label:"HOLD", icon:"◐" },
};
const DC = {
  APPROVE: { color:"#34d399", bg:"#011a10", border:"#065f46", label:"AUTO APPROVE" },
  REJECT:  { color:"#f87171", bg:"#200808", border:"#991b1b", label:"REJECT"       },
  HOLD:    { color:"#fbbf24", bg:"#1e1506", border:"#92400e", label:"HOLD FOR REVIEW" },
};

// ─── UI Components ─────────────────────────────────────────────────────────
function Pill({ status }) {
  const c = SC[status];
  return <span style={{ display:"inline-flex", alignItems:"center", gap:4, background:c.bg, color:c.color, border:`1px solid ${c.color}35`, borderRadius:3, padding:"1px 7px", fontSize:10, fontWeight:700, letterSpacing:"0.06em", fontFamily:"monospace" }}>{c.icon} {c.label}</span>;
}
function DPill({ decision, large }) {
  const c = DC[decision]||DC.HOLD;
  return <span style={{ display:"inline-flex", alignItems:"center", background:c.bg, color:c.color, border:`1px solid ${c.border}`, borderRadius:4, padding:large?"5px 14px":"2px 8px", fontSize:large?12:10, fontWeight:800, letterSpacing:"0.07em", fontFamily:"monospace" }}>{c.label}</span>;
}

function CheckRow({ check }) {
  const [open, setOpen] = useState(false);
  const c = SC[check.status];
  return (
    <div style={{ borderBottom:"1px solid #0f1a2e", cursor:"pointer" }} onClick={()=>setOpen(!open)}>
      <div style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 16px" }}>
        <span style={{ color:c.color, fontSize:11, width:14, textAlign:"center", fontWeight:800 }}>{c.icon}</span>
        <span style={{ flex:1, fontSize:11.5, color:"#cbd5e1", fontFamily:"monospace" }}>{check.label}</span>
        <Pill status={check.status} />
        <span style={{ color:"#2d3a50", fontSize:10, marginLeft:2 }}>{open?"▲":"▼"}</span>
      </div>
      {open && <div style={{ padding:"2px 16px 10px 40px", fontSize:11, color:"#64748b", lineHeight:1.7 }}>{check.detail}</div>}
    </div>
  );
}

function CaseCard({ row, decision, isSelected, onSelect }) {
  const c = DC[decision];
  return (
    <div onClick={onSelect} style={{ padding:"10px 14px", cursor:"pointer", background:isSelected?"#0a1525":"transparent", borderLeft:isSelected?`3px solid ${c.color}`:"3px solid transparent", borderBottom:"1px solid #0d1829", transition:"background 0.1s" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:3 }}>
        <span style={{ fontSize:11.5, color:"#e2e8f0", fontWeight:600, fontFamily:"monospace", maxWidth:155, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
          {row.campaign_name||row.campaign||"Campaign"}
        </span>
        <DPill decision={decision} />
      </div>
      <div style={{ fontSize:10, color:"#374151" }}>{row.category||"—"} · {row.recipient_type||"—"}</div>
    </div>
  );
}

// ─── Demo data ─────────────────────────────────────────────────────────────
const DEMO = [
  { campaign_name:"support-bhagyavathi-duriseati", category:"Medical", recipient_type:"vendor", account_number:"23030200002897", ifsc_code:"FDRL0002303", bank_name:"Federal Bank", name_entered_by_user:"SRI JOSHNAV MEDICAL AND SURGICALS", name_as_in_bank:"SRI JOSHNAV MEDICAL AND SURGICALS", account_status:"VERIFIED", beneficiary_name:"Bhagyavathi Duriseati", recipient_name:"DURGYALA SHRAVAN", co_name:"Durgyala Shravan", currency:"INR", pan_status:"VALID", pan_name:"DURGYALA SHRAVAN", gst_status:"VALID", is_fcra_account:"No", relationship_proof_present:"yes", relationship_beneficiary_name_match:"yes", relationship_recipient_name_match:"yes", vendor_category:"medical surgical", id_proof_url:"", relationship_proof_url:"" },
  { campaign_name:"support-stray-animals-967", category:"Animals", recipient_type:"myself", account_number:"20266929280", ifsc_code:"SBIN0016332", bank_name:"State Bank of India", name_entered_by_user:"Samira Fernandez", name_as_in_bank:"MRS SAMIRA FERNANDEZ", account_status:"VERIFIED", beneficiary_name:"Stray Animals", recipient_name:"Samira Fernandez", co_name:"Samira Fernandez", currency:"INR", is_fcra_account:"No", id_proof_url:"", id_proof_type:"Passport" },
  { campaign_name:"support-kamlesh-137", category:"Medical", recipient_type:"beneficiary", account_number:"9876543210", ifsc_code:"HDFC0001234", bank_name:"HDFC Bank", name_entered_by_user:"Kamlesh Sharma", name_as_in_bank:"KAMLESH SHARMA", account_status:"VERIFIED", beneficiary_name:"Kamlesh Sharma", recipient_name:"Kamlesh Sharma", co_name:"Priya Sharma", currency:"INR", is_fcra_account:"No", id_proof_url:"", id_proof_type:"Aadhaar" },
  { campaign_name:"support-child-of-lata-yamanu", category:"Education", recipient_type:"family_member", account_number:"1234567890", ifsc_code:"ICIC0001234", bank_name:"ICICI Bank", name_entered_by_user:"Lata Yamanu", name_as_in_bank:"LATA YAMANU", account_status:"VERIFIED", beneficiary_name:"Aryan Yamanu", recipient_name:"Lata Yamanu", co_name:"Lata Yamanu", currency:"INR", is_fcra_account:"No", id_proof_url:"", relationship_proof_url:"" },
  { campaign_name:"support-animals-10020-vendor-mismatch", category:"Animals", recipient_type:"vendor", account_number:"9988776655", ifsc_code:"AXIS0001234", bank_name:"Axis Bank", name_entered_by_user:"Sunrise School Supplies", name_as_in_bank:"SUNRISE SCHOOL SUPPLIES", account_status:"VERIFIED", beneficiary_name:"Stray Dogs NGO", recipient_name:"Sunrise School Supplies", co_name:"Ravi Kumar", currency:"INR", pan_status:"VALID", pan_name:"SUNRISE SCHOOL SUPPLIES", gst_status:"VALID", is_fcra_account:"No", vendor_category:"school stationery", id_proof_url:"", relationship_proof_url:"" },
];

// ─── Main App ───────────────────────────────────────────────────────────────
export default function KYCEngine() {
  const [cases, setCases]         = useState([]);
  const [ocrStore, setOcrStore]   = useState({});      // { rowIndex: { id_proof, rel_proof } }
  const [selected, setSelected]   = useState(null);
  const [filter, setFilter]       = useState("ALL");
  const [search, setSearch]       = useState("");
  const [isDrag, setIsDrag]       = useState(false);
  const fileRef = useRef();
  const abortRef = useRef(false);
  const [isBatchRunning, setIsBatchRunning] = useState(false);


  // Run checks for all cases with pause support
  const runAllChecks = useCallback(async () => {
    abortRef.current = false;
    setIsBatchRunning(true);
    for (let i = 0; i < cases.length; i++) {
      if (abortRef.current) break;
      setSelected(i);
      setOcrStore(s => ({ ...s, [i]: { _checked: true } }));
      // small delay so UI updates are visible
      await new Promise(r => setTimeout(r, 80));
    }
    setIsBatchRunning(false);
  }, [cases]);

  const pauseChecks = useCallback(() => {
    abortRef.current = true;
    setIsBatchRunning(false);
  }, []);

  const handleFile = useCallback((file) => {
    if (!file) return;
    const r = new FileReader();
    r.onload = e => {
      const rows = parseCSV(e.target.result);
      if (rows.length) { setCases(rows); setOcrStore({}); setSelected(0); }
    };
    r.readAsText(file);
  }, []);

  // Compute decisions
  const processed = cases.map((row, i) => ({
    row, index: i,
    ocr: ocrStore[i] || {},
    ...runKYC(row, ocrStore[i] || {}),
  }));

  const summary = {
    APPROVE: processed.filter(c=>c.decision==="APPROVE").length,
    REJECT:  processed.filter(c=>c.decision==="REJECT").length,
    HOLD:    processed.filter(c=>c.decision==="HOLD").length,
  };

  const filtered = processed.filter(({ row, decision }) => {
    const mf = filter==="ALL" || decision===filter;
    const q  = search.toLowerCase();
    const ms = !q
      || (row.campaign_name||row.campaign||"").toLowerCase().includes(q)
      || (row.category||"").toLowerCase().includes(q)
      || (row.recipient_type||"").toLowerCase().includes(q);
    return mf && ms;
  });

  const downloadSample = () => {
    const headers = [
      "campaign_name","category","recipient_type","currency",
      "account_status","account_number","ifsc_code","bank_name",
      "name_as_in_bank","account_holder_name","beneficiary_name",
      "recipient_name","co_name","is_fcra_account",
      "id_proof_url","id_proof_type",
      "relationship_proof_url",
      "pan_status","pan_name",
      "gst_status","vendor_category",
      "campaign_ngo_name","swift_code","routing_number"
    ];
    const samples = [
      ["support-ravi-kumar-medical","Medical","beneficiary","INR","VERIFIED","9876543210","HDFC0001234","HDFC Bank","RAVI KUMAR","Ravi Kumar","Ravi Kumar","Ravi Kumar","Priya Kumar","No","https://your-public-url.com/aadhaar_front.jpg","Aadhaar","","","","","","","",""],
      ["support-anita-sharma-family","Medical","family_member","INR","VERIFIED","1122334455","ICIC0005678","ICICI Bank","ANITA SHARMA","Anita Sharma","Rakesh Sharma","Anita Sharma","Anita Sharma","No","https://your-public-url.com/pan_card.jpg","PAN","https://your-public-url.com/birth_cert.jpg","","","","","","",""],
      ["support-city-hospital","Medical","treating_hospital","INR","VERIFIED","2233445566","SBIN0009999","SBI","CITY HOSPITAL AND RESEARCH","City Hospital And Research","Meena Patel","City Hospital And Research","Suresh Patel","No","https://your-public-url.com/pan_hospital.jpg","PAN","https://your-public-url.com/estimation_letter.jpg","VALID","CITY HOSPITAL AND RESEARCH","","","","",""],
      ["support-medical-vendor","Medical","vendor","INR","VERIFIED","3344556677","AXIS0001234","Axis Bank","SRI JOSHNAV MEDICAL AND SURGICALS","Sri Joshnav Medical And Surgicals","Bhagyavathi D","Sri Joshnav Medical And Surgicals","Durgyala Shravan","No","https://your-public-url.com/pan_vendor.jpg","PAN","https://your-public-url.com/gst_invoice.jpg","VALID","SRI JOSHNAV MEDICAL AND SURGICALS","VALID","medical surgical","","",""],
      ["support-stray-animals","Animals","myself","INR","VERIFIED","4455667788","SBIN0016332","State Bank of India","MRS SAMIRA FERNANDEZ","Samira Fernandez","Stray Animals","Samira Fernandez","Samira Fernandez","No","https://your-public-url.com/passport.jpg","Passport","","","","","","","",""],
      ["support-child-education","Education","family_member","INR","VERIFIED","5566778899","PUNB0001234","Punjab National Bank","LATA YAMANU","Lata Yamanu","Aryan Yamanu","Lata Yamanu","Lata Yamanu","No","https://your-public-url.com/voter_id.jpg","Voter ID","https://your-public-url.com/birth_cert_child.jpg","","","","","","",""],
      ["support-ngo-orphans","Social","ngo","INR","VERIFIED","6677889900","HDFC0009876","HDFC Bank","HOPE FOUNDATION TRUST","Hope Foundation Trust","Orphan Children","Hope Foundation Trust","Ramesh Nair","No","https://your-public-url.com/pan_ngo.jpg","PAN","","VALID","HOPE FOUNDATION TRUST","","","Hope Foundation Trust","",""],
      ["support-usd-fcra","Medical","treating_hospital","USD","VERIFIED","7788990011","SBIN0000001","State Bank of India","NATIONAL CANCER TRUST","National Cancer Trust","Suresh Mehta","National Cancer Trust","Kavita Mehta","Yes","https://your-public-url.com/pan_trust.jpg","PAN","https://your-public-url.com/fcra_cert.jpg","VALID","NATIONAL CANCER TRUST","","","","SBININBB",""],
    ];
    const csv = [headers.join(","), ...samples.map(r => r.map(v=>`"${v}"`).join(","))].join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
    a.download = "kyc_engine_sample.csv"; a.click();
  };

  const exportCSV = () => {
    const rows = processed.map(({ row, decision, checks }) => ({
      ...row,
      kyc_decision:    decision,
      failed_checks:   checks.filter(c=>c.status!=="pass").map(c=>c.label).join("; "),
      action_required: checks.filter(c=>c.status!=="pass").map(c=>c.detail).join(" | "),
    }));
    const h = Object.keys(rows[0]);
    const csv = [h.join(","), ...rows.map(r=>h.map(k=>`"${(r[k]||"").toString().replace(/"/g,'""')}"`).join(","))].join("\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
    a.download = `kyc_results_${Date.now()}.csv`; a.click();
  };

  const selRow = processed[selected];

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100vh", background:"#050c1a", color:"#e2e8f0", fontFamily:"'DM Mono','Courier New',monospace" }}>

      {/* ── Top bar ── */}
      <div style={{ height:50, padding:"0 20px", display:"flex", alignItems:"center", justifyContent:"space-between", borderBottom:"1px solid #0d1829", background:"#060d1e", flexShrink:0 }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <div style={{ width:26, height:26, borderRadius:6, background:"linear-gradient(135deg,#6366f1,#8b5cf6)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:13, fontWeight:900, color:"#fff" }}>K</div>
          <span style={{ fontSize:12, fontWeight:700, color:"#f1f5f9", letterSpacing:"0.07em" }}>KYC ENGINE</span>
          <span style={{ fontSize:10, color:"#1e2d45", letterSpacing:"0.06em" }}>/ MILAAP VERIFICATIONS</span>
        </div>
        <div style={{ display:"flex", gap:12, alignItems:"center" }}>
          <div style={{ display:"flex", gap:14, fontSize:11 }}>
            {Object.entries(summary).map(([k,v])=>(
              <span key={k} style={{ color:DC[k].color }}>{v} <span style={{ opacity:0.5 }}>{k}</span></span>
            ))}
          </div>
          {isBatchRunning
            ? <button onClick={pauseChecks} style={{ background:"#1c1506", border:"1px solid #78350f", color:"#fbbf24", padding:"4px 12px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"monospace" }}>⏸ Pause</button>
            : <button onClick={runAllChecks} disabled={cases.length===0} style={{ background:"#0c1e38", border:"1px solid #1a3560", color:cases.length===0?"#1e2d45":"#60a5fa", padding:"4px 12px", borderRadius:4, cursor:cases.length===0?"not-allowed":"pointer", fontSize:11, fontFamily:"monospace" }}>▶ Run Checks</button>
          }
          <button onClick={downloadSample} style={{ background:"#0e1e30", border:"1px solid #1a2d45", color:"#64748b", padding:"4px 12px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"monospace" }}>
            ↓ Sample CSV
          </button>
          <button onClick={exportCSV} style={{ background:"#0e1e30", border:"1px solid #1a2d45", color:"#94a3b8", padding:"4px 12px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"monospace" }}>
            ↓ Export Results
          </button>
          <button onClick={()=>fileRef.current?.click()} style={{ background:"#0f1e38", border:"1px solid #1e3a6e", color:"#818cf8", padding:"4px 12px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"monospace" }}>
            ↑ Upload CSV
          </button>
          <input ref={fileRef} type="file" accept=".csv" style={{ display:"none" }} onChange={e=>handleFile(e.target.files[0])} />
        </div>
      </div>

      <div style={{ display:"flex", flex:1, overflow:"hidden" }}>

        {/* ── Sidebar ── */}
        <div style={{ width:295, flexShrink:0, borderRight:"1px solid #0d1829", display:"flex", flexDirection:"column", background:"#040b18" }}
          onDragOver={e=>{e.preventDefault();setIsDrag(true);}}
          onDragLeave={()=>setIsDrag(false)}
          onDrop={e=>{e.preventDefault();setIsDrag(false);const f=e.dataTransfer.files[0];if(f?.name.endsWith(".csv"))handleFile(f);}}>

          <div style={{ padding:"10px 12px", borderBottom:"1px solid #0d1829" }}>
            <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search campaigns..." style={{ width:"100%", background:"#090f1e", border:"1px solid #152030", borderRadius:4, padding:"6px 9px", color:"#94a3b8", fontSize:11, fontFamily:"monospace", outline:"none", boxSizing:"border-box", marginBottom:7 }} />
            <div style={{ display:"flex", gap:3 }}>
              {["ALL","APPROVE","HOLD","REJECT"].map(f=>(
                <button key={f} onClick={()=>setFilter(f)} style={{ flex:1, padding:"3px 0", borderRadius:3, cursor:"pointer", fontSize:9, fontFamily:"monospace", fontWeight:700, letterSpacing:"0.03em", border:"1px solid", borderColor:filter===f?(DC[f]?.color||"#6366f1")+"50":"#152030", background:filter===f?(DC[f]?.bg||"#090f1e"):"transparent", color:filter===f?(DC[f]?.color||"#6366f1"):"#334155" }}>
                  {f==="ALL"?`ALL (${cases.length})`:`${f} (${summary[f]||0})`}
                </button>
              ))}
            </div>
          </div>

          <div style={{ flex:1, overflowY:"auto", position:"relative" }}>
            {filtered.map(({ row, decision, index, isProcessing }) => (
              <CaseCard key={index} row={row} decision={decision} isSelected={index===selected} onSelect={()=>setSelected(index)} />
            ))}
            {cases.length===0 && (
              <div style={{ padding:32, textAlign:"center" }}>
                <div style={{ fontSize:22, marginBottom:10 }}>📂</div>
                <div style={{ fontSize:11, color:"#1e2d45", lineHeight:1.7 }}>No cases loaded.<br/>Upload a CSV to begin.</div>
              </div>
            )}
            {cases.length>0 && filtered.length===0 && <div style={{ padding:24, textAlign:"center", color:"#1e2d45", fontSize:11 }}>No cases match filter</div>}
            {isDrag && (
              <div style={{ position:"absolute", inset:6, background:"#0c2040cc", display:"flex", alignItems:"center", justifyContent:"center", fontSize:13, color:"#60a5fa", border:"2px dashed #2563eb", borderRadius:6 }}>
                Drop CSV to load
              </div>
            )}
          </div>
        </div>

        {/* ── Detail Panel ── */}
        {selRow ? (
          <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden" }}>

            {/* Header */}
            <div style={{ padding:"16px 24px", borderBottom:"1px solid #0d1829", background:"#050c1a", flexShrink:0 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:10 }}>
                <div>
                  <div style={{ fontSize:15, fontWeight:700, color:"#f1f5f9", fontFamily:"monospace", marginBottom:2 }}>
                    {selRow.row.campaign_name||selRow.row.campaign||"Campaign"}
                  </div>
                  <div style={{ fontSize:10.5, color:"#334155" }}>
                    {[selRow.row.category, selRow.row.recipient_type, selRow.row.currency||"INR"].filter(Boolean).join(" · ")}
                  </div>
                </div>
                <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end", gap:6 }}>
                  <DPill decision={selRow.decision} large />
                  <div style={{ fontSize:10, color:"#334155", fontFamily:"monospace" }}>
                    {selRow.checks.filter(c=>c.status==="pass").length}✓&nbsp;
                    {selRow.checks.filter(c=>c.status==="reject").length}✗&nbsp;
                    {selRow.checks.filter(c=>c.status==="hold").length}◐
                  </div>
                </div>
              </div>
              {/* Progress bar */}
              <div style={{ display:"flex", gap:1, height:3, borderRadius:2, overflow:"hidden" }}>
                {selRow.checks.map((ch,i)=><div key={i} style={{ flex:1, background:SC[ch.status].color+"60" }} />)}
              </div>
            </div>

            <div style={{ flex:1, overflow:"auto" }}>
              {/* Info grid */}
              <div style={{ padding:"14px 24px", borderBottom:"1px solid #0d1829", display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:"8px 20px" }}>
                {[["Beneficiary",selRow.row.beneficiary_name],["Recipient",selRow.row.recipient_name],["CO Name",selRow.row.co_name],["Account No.",selRow.row.account_number],["IFSC",selRow.row.ifsc_code],["Bank",selRow.row.bank_name],["Name (User)",selRow.row.account_holder_name||selRow.row.name_entered_by_user],["Name (Bank)",selRow.row.name_as_in_bank],["FCRA",selRow.row.is_fcra_account]].map(([l,v])=>v?(
                  <div key={l}>
                    <div style={{ fontSize:9, color:"#1e2d45", textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:1 }}>{l}</div>
                    <div style={{ fontSize:11.5, color:"#94a3b8", fontFamily:"monospace" }}>{v}</div>
                  </div>
                ):null)}
              </div>

              {/* Checks */}
              <div>
                <div style={{ padding:"10px 16px 5px", fontSize:9.5, color:"#1e2d45", textTransform:"uppercase", letterSpacing:"0.1em", fontWeight:700 }}>
                  Verification Checks ({selRow.checks.length})
                </div>
                {selRow.checks.map(ch=><CheckRow key={ch.id} check={ch} />)}
              </div>

              {/* Action reasons */}
              {selRow.checks.filter(c=>c.status!=="pass").length>0 && (
                <div style={{ padding:"14px 24px", borderTop:"1px solid #0d1829", background:DC[selRow.decision]?.bg }}>
                  <div style={{ fontSize:9.5, color:DC[selRow.decision]?.color, textTransform:"uppercase", letterSpacing:"0.1em", fontWeight:700, marginBottom:8 }}>
                    {selRow.decision==="REJECT"?"Rejection Reasons":"Action Required"}
                  </div>
                  {selRow.checks.filter(c=>c.status!=="pass").map((x,i)=>(
                    <div key={i} style={{ fontSize:11, color:"#94a3b8", marginBottom:5, paddingLeft:10, borderLeft:`2px solid ${DC[selRow.decision]?.color}40`, lineHeight:1.6 }}>{x.detail}</div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", color:"#1e2d45", fontSize:12, gap:10 }}>
            {cases.length===0
              ? <><div style={{ fontSize:32 }}>⬆</div><div style={{ fontSize:13, color:"#2d3a50" }}>Upload a CSV to get started</div><div style={{ fontSize:11, color:"#1e2d45", marginTop:4 }}>Click "Upload CSV" in the top right</div></>
              : <div>Select a case from the list</div>
            }
          </div>
        )}
      </div>
    </div>
  );
}
