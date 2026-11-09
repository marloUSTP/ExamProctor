import { Skeleton } from "@/components/ui/skeleton"

export function TeacherLoading({ variant }: { variant: "monitor" | "answers" | "results" }) {
  const label = variant === "monitor" ? "Loading students and activity" : variant === "answers" ? "Loading answers" : "Loading results"
  return (
    <div role="status" aria-label={label} aria-busy="true">
      <span className="sr-only">{label}…</span>
      {variant === "answers" ? (
        <div aria-hidden="true" className="space-y-3">
          {[0, 1, 2].map((row) => <div key={row} className="space-y-3 rounded-lg border p-3">
            <div className="flex justify-between gap-4"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-4 w-12" /></div>
            <Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-4/5" />
            <Skeleton className="h-8 w-28" />
          </div>)}
        </div>
      ) : (
        <div aria-hidden="true" className={variant === "monitor" ? "grid items-start gap-4 lg:grid-cols-[1fr_340px]" : "space-y-4"}>
          <div className="space-y-4 rounded-xl border p-4">
            <Skeleton className="h-5 w-32" /><Skeleton className="h-3 w-3/5" />
            {[0, 1, 2, 3].map((row) => <div key={row} className="flex items-center gap-4 border-t pt-4">
              <div className="flex-1 space-y-2"><Skeleton className="h-4 w-2/5" /><Skeleton className="h-3 w-3/5" /></div>
              <Skeleton className="h-6 w-20" />
            </div>)}
          </div>
          {variant === "monitor" && <div className="space-y-4 rounded-xl border p-4">
            <Skeleton className="h-5 w-28" />
            {[0, 1, 2].map((row) => <div key={row} className="space-y-2 border-t pt-4"><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-1/2" /></div>)}
          </div>}
        </div>
      )}
    </div>
  )
}
