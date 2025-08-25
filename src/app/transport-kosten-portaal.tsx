"use client";

import React, { useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { Upload, Calculator, Info, Settings, Truck } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// ------------------------------------------------------------
// Transportkosten Portaal – Staffeltarief (vast bedrag per levering)
// ------------------------------------------------------------
// • Excel: kolommen "Postcode", "1 ton", "2 ton", … (waarde = vast tarief per levering)
// • Gewicht bepaalt alleen welke staffel geldt (ceil/floor/nearest/interp)
// • Totaal = staffeltarief + (aantal leveringen × toeslag)
// • Standaard toeslag €35 per levering
// ------------------------------------------------------------

export default function TransportkostenPortaal() {
  const [rows, setRows] = useState([]);
  const [columns, setColumns] = useState([]);

  const [postcode, setPostcode] = useState("");
  const [weight, setWeight] = useState("");
  const [unit, setUnit] = useState("kg");
  const [deliveries, setDeliveries] = useState(1);
  const [surcharge, setSurcharge] = useState(35);
  const [tierMethod, setTierMethod] = useState("ceil"); // ceil | floor | nearest | interp

  const [message, setMessage] = useState("");
  const [result, setResult] = useState(null);

  const nf = useMemo(() => new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }), []);

  function onFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = evt.target.result;
        const wb = XLSX.read(data, { type: "binary" });
        const wsname = wb.SheetNames[0];
        const ws = wb.Sheets[wsname];
        const json = XLSX.utils.sheet_to_json(ws, { defval: "" });
        if (!json.length) { setMessage("Het bestand lijkt geen rijen te bevatten."); setRows([]); setColumns([]); return; }
        setRows(json);
        setColumns(Object.keys(json[0]));
        setMessage("");
      } catch (err) {
        console.error(err);
        setMessage("Kon het Excel-bestand niet lezen. Controleer het formaat en probeer opnieuw.");
      }
    };
    reader.readAsBinaryString(file);
  }

  function extractPrefixFromPostcode(pc) {
    const digits = (pc || "").toString().replace(/\D/g, "");
    if (digits.length < 2) return null;
    return digits.slice(0, 2);
  }

  function toTons(value, unit) {
    const v = parseFloat(String(value).replace(",", "."));
    if (isNaN(v) || v <= 0) return null;
    return unit === "kg" ? v / 1000 : v;
  }

  function pickStaffel(prefix, tons) {
    if (!rows.length) return null;
    const match = rows.find(r => {
      const raw = String(r["Postcode"] ?? "").trim();
      const onlyDigits = raw.replace(/\D/g, "");
      const two = onlyDigits.slice(0, 2);
      return two === prefix;
    });
    if (!match) return null;

    const tonCols = columns.filter(c => /(^|\s)(\d{1,3})\s*(t|ton|tonne)s?($|\b)/i.test(c));
    const numeric = tonCols
      .map(c => { const m = c.match(/(\d{1,3})/); return m ? { col: c, tons: parseInt(m[1], 10) } : null; })
      .filter(Boolean)
      .sort((a, b) => a.tons - b.tons);
    if (!numeric.length) return null;

    // clamp naar beschikbare range
    const minT = numeric[0].tons;
    const maxT = numeric[numeric.length - 1].tons;
    const t = Math.min(Math.max(tons, minT), maxT);

    if (tierMethod === "floor") {
      return [...numeric].reverse().find(n => t >= n.tons) || numeric[0];
    }
    if (tierMethod === "nearest") {
      return [...numeric].sort((a, b) => Math.abs(a.tons - t) - Math.abs(b.tons - t))[0];
    }
    if (tierMethod === "interp") {
      const lower = [...numeric].reverse().find(n => n.tons <= t) || numeric[0];
      const upper = numeric.find(n => n.tons >= t) || numeric[numeric.length - 1];
      return { col: `${lower.tons}–${upper.tons} (interp)`, tons: t, lower, upper };
    }
    // default: ceil
    return numeric.find(n => t <= n.tons) || numeric[numeric.length - 1];
  }

  function staffelTarief(row, staffel) {
    // Interpolatie: lineaire mix tussen twee staffels
    if (staffel && staffel.lower && staffel.upper) {
      const rL = parseFloat(String(row[String(staffel.lower.col)]).replace(",", "."));
      const rU = parseFloat(String(row[String(staffel.upper.col)]).replace(",", "."));
      if (!Number.isFinite(rL) || !Number.isFinite(rU)) return null;
      const t = (staffel.tons - staffel.lower.tons) / (staffel.upper.tons - staffel.lower.tons || 1);
      return rL + t * (rU - rL);
    }
    const v = parseFloat(String(row[String(staffel.col)]).replace(",", "."));
    return Number.isFinite(v) ? v : null;
  }

  function handleCalculate() {
    setResult(null);
    setMessage("");

    if (!rows.length) { setMessage("Upload eerst een Excel met tarieven."); return; }
    const prefix = extractPrefixFromPostcode(postcode);
    if (!prefix) { setMessage("Voer een geldige Duitse postcode in (minimaal 2 cijfers)."); return; }
    const tons = toTons(weight, unit);
    if (tons == null) { setMessage("Voer een geldig gewicht in."); return; }

    const row = rows.find(r => (String(r["Postcode"]).replace(/\D/g, "").slice(0, 2) === prefix));
    if (!row) { setMessage(`Geen rij gevonden voor prefix ${prefix}.`); return; }

    const staffel = pickStaffel(prefix, tons);
    if (!staffel) { setMessage("Geen staffelkolommen gevonden (verwacht: 1 ton, 2 ton, …)."); return; }

    const rate = staffelTarief(row, staffel);
    if (rate == null) { setMessage("Lege of ongeldige staffeltarieven in Excel."); return; }

    const staffelLabel = staffel.lower ? staffel.col : `${staffel.tons}`;
    const base = rate; // VAST BEDRAG PER LEVERING
    const surchargeTotal = (Number.isFinite(+deliveries) ? Math.max(1, +deliveries) : 1) * (Number.isFinite(+surcharge) ? Math.max(0, +surcharge) : 35);
    const total = base + surchargeTotal;

    setResult({ prefix, gewichtTons: tons, staffel: staffelLabel, staffelTarief: rate, base, surchargeTotal, total });
  }

  function fillTest_10115_12_5t() {
    setPostcode("10115"); setWeight("12.5"); setUnit("ton"); setDeliveries(1); setSurcharge(35); setTimeout(() => handleCalculate(), 0);
  }
  function fillTest_50667_8_2t() {
    setPostcode("50667"); setWeight("8.2"); setUnit("ton"); setDeliveries(1); setSurcharge(35); setTimeout(() => handleCalculate(), 0);
  }

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900 p-6">
      <div className="mx-auto max-w-5xl grid gap-6">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-3">
            <Truck className="h-7 w-7" /> Transportkosten Portaal (staffeltarief)
          </h1>
        </header>

        <div className="grid md:grid-cols-2 gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Upload className="h-5 w-5" />Excel upload</CardTitle>
              <CardDescription>Postcode + kolommen “1 ton … 24 ton” (waarde = <strong>vast bedrag per levering</strong>).</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <Input type="file" accept=".xlsx,.xls,.csv" onChange={onFile} />
              {message && <div className="text-sm text-red-600 flex items-center gap-2"><Info className="h-4 w-4" />{message}</div>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Calculator className="h-5 w-5" />Bereken</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid gap-2">
                <Label>Duitse postcode</Label>
                <Input value={postcode} onChange={e => setPostcode(e.target.value)} placeholder="10115" />
              </div>
              <div className="grid gap-2">
                <Label>Gewicht</Label>
                <div className="flex gap-2">
                  <Input value={weight} onChange={e => setWeight(e.target.value)} placeholder="12.5" />
                  <select value={unit} onChange={e => setUnit(e.target.value)} className="border rounded p-1">
                    <option value="kg">kg</option>
                    <option value="ton">ton</option>
                  </select>
                </div>
                <p className="text-xs text-neutral-500">Gewicht wordt alleen gebruikt om de <em>staffel</em> te bepalen.</p>
              </div>
              <div className="grid gap-2">
                <Label>Aantal leveringen</Label>
                <Input value={deliveries} onChange={e => setDeliveries(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label>Toeslag per levering (€)</Label>
                <Input value={surcharge} onChange={e => setSurcharge(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label>Staffelmethode</Label>
                <select value={tierMethod} onChange={e => setTierMethod(e.target.value)} className="border rounded p-1">
                  <option value="ceil">Naar boven (ceil)</option>
                  <option value="floor">Naar beneden (floor)</option>
                  <option value="nearest">Dichtstbij</option>
                  <option value="interp">Interpolatie (lineair)</option>
                </select>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button onClick={handleCalculate}>Bereken</Button>
                <Button type="button" variant="secondary" onClick={fillTest_10115_12_5t}>Test: 10115 • 12,5 t</Button>
                <Button type="button" variant="secondary" onClick={fillTest_50667_8_2t}>Test: 50667 • 8,2 t</Button>
              </div>

              {result && (
                <div className="border rounded bg-white p-4 text-sm">
                  <div className="flex justify-between"><span>Prefix</span><span>{result.prefix}</span></div>
                  <div className="flex justify-between"><span>Gewicht (t)</span><span>{result.gewichtTons.toFixed(2)}</span></div>
                  <div className="flex justify-between"><span>Staffel gebruikt</span><span>{String(result.staffel)}</span></div>
                  <div className="flex justify-between"><span>Staffeltarief</span><span>{nf.format(result.staffelTarief)}</span></div>
                  <div className="flex justify-between"><span>Toeslagen</span><span>{nf.format(result.surchargeTotal)}</span></div>
                  <div className="flex justify-between font-semibold border-t pt-2"><span>Totaal per levering</span><span>{nf.format(result.total)}</span></div>
                </div>
              )}

              {!result && <div className="text-xs text-neutral-500 flex gap-2"><Settings className="h-4 w-4" /> Vul gegevens in en klik op Bereken.</div>}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
