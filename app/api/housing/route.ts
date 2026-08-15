import { selectModel } from "@/lib/agent";
import { runHousingAgent, type Shortlisted } from "@/lib/housing-agent";
import { searchListings } from "@/lib/listings";
import { resolveAddress, buildProfile } from "@/lib/nyc";
import type { AgentStep } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Ev =
  | { stage: "searching"; message: string }
  | { stage: "step"; step: AgentStep }
  | { stage: "results"; results: Shortlisted[] }
  | { stage: "done" }
  | { stage: "error"; message: string };

export async function POST(req: Request) {
  const { brief } = await req.json();

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      // Guarded close — closing twice throws ERR_INVALID_STATE and fails the
      // whole response, which is what broke the scan route's fallback paths.
      let closed = false;
      const close = () => {
        if (!closed) {
          closed = true;
          controller.close();
        }
      };
      const send = (e: Ev) => {
        if (!closed) controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      };

      try {
        const model = selectModel();
        let results: Shortlisted[] | undefined;

        if (model) {
          send({ stage: "searching", message: "Agent reading your brief…" });
          try {
            results = await runHousingAgent(String(brief ?? ""), model, (step) =>
              send({ stage: "step", step })
            );
          } catch (e: any) {
            send({
              stage: "step",
              step: { type: "thought", text: `Agent failed (${e?.message ?? "error"}), falling back.` },
            });
          }
        }

        // Deterministic fallback: plain filtered search, so the marketplace always
        // returns something even with no key or a rate-limited model.
        if (!results || results.length < 15) {
          send({ stage: "searching", message: "Matching listings…" });
          const brief_ = String(brief ?? "").toLowerCase();
          const boroughs = ["manhattan", "brooklyn", "bronx", "queens", "staten island"].filter((borough) => brief_.includes(borough));
          const incomeMatch = brief_.match(/household income\s*\$?\s*([0-9][0-9,]{2,8})/);
          const rentMatch = brief_.match(/(?:under|max(?:imum)?(?: rent)?|budget(?: of)?)\s*\$?\s*([0-9][0-9,]{2,5})/);
          const priorityMatch = brief_.match(/priority:\s*([^;]+)/);
          const picks = searchListings({
            boroughs,
            annualIncome: incomeMatch ? Number(incomeMatch[1].replace(/,/g, "")) : undefined,
            sortBy: priorityMatch?.[1] ?? "newest listed",
            actionableOnly: true,
            maxRent: rentMatch ? Number(rentMatch[1].replace(/,/g, "")) : undefined,
            limit: 5000,
          });

          // Check the buildings even on the fallback path. "We tell you which
          // buildings are bad" is the whole product, so it must not disappear
          // just because the model was rate-limited.
          results = await Promise.all(
            picks.map(async (listing) => {
              let openViolations: number | undefined;
              let worstFloor: number | null = null;
              try {
                const addr = await resolveAddress(`${listing.address}, ${listing.borough}`);
                const profile = await buildProfile(addr);
                openViolations = profile.openViolations;
                worstFloor = profile.floors.worstFloor;
              } catch {}
              const base = listing.rent
                ? `$${listing.rent.toLocaleString()} · ${listing.unitSize ?? "unit"} · ${listing.borough}`
                : `${listing.units ?? 0} affordable units · ${listing.borough}`;
              const verdict =
                openViolations === undefined
                  ? ""
                  : openViolations === 0
                    ? " · building record is clean"
                    : ` · ${openViolations.toLocaleString()} open violations on record`;
              return { listing, reason: base + verdict, openViolations, worstFloor };
            })
          );
        }

        send({ stage: "results", results });
        send({ stage: "done" });
      } catch (err: any) {
        send({ stage: "error", message: err?.message ?? "Search failed" });
      } finally {
        close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
