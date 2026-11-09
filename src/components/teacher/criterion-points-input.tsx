"use client"

import { useState } from "react"
import { Input } from "@/components/ui/input"

/** Keep an empty/unfinished decimal editable without turning it into a visible zero. */
export function CriterionPointsInput({ id, value, onChange }: {
  id: string; value: number; onChange: (value: number) => void
}) {
  const [draft, setDraft] = useState<{ text: string; value: number } | null>(null)
  const text = draft?.value === value ? draft.text : String(value)

  return <Input id={id} type="text" inputMode="decimal" value={text}
    aria-invalid={text !== "" && (!Number.isFinite(value) || value <= 0 || value > 100)}
    onChange={(event) => {
      if (!/^\d*(\.\d*)?$/.test(event.target.value)) return
      const next = event.target.value.replace(/^0+(?=\d)/, "")
      const numeric = Number(next) || 0
      setDraft({ text: next, value: numeric })
      onChange(numeric)
    }}
    onBlur={() => setDraft({ text: value === 0 ? "" : String(value), value })} />
}
