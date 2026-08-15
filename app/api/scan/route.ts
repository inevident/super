import { resolveAddress, buildProfile } from "@/lib/nyc";
import { runAgent, selectModel, fallbackPicks } from "@/lib/agent";
import { DEMO_PROFILE, DEMO_STEPS, DEMO_PICKS } from "@/lib/fixtures";
import type { Pick, ScanEvent } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const { address, demo } = await req.json();

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      // Closing twice throws ERR_INVALID_STATE and fails the whole response pipe,
      // which silently killed demo mode and the graceful-error path. Guard it.
      let closed = false;
      const close = () => {
        if (!closed) {
          closed = true;
          controller.close();
        }
      };
      const send = (e: ScanEvent) => {
        if (!closed) controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      };
      // The scan is the centerpiece; a beat between stages lets the room read it.
      const beat = (ms: number) => new Promise((r) => setTimeout(r, ms));

      try {
        if (demo) {
          send({ stage: "resolving", message: "Locating building…" });
          await beat(500);
          send({ stage: "address", address: DEMO_PROFILE.address });
          send({ stage: "records", message: "Pulling HPD violations and 311 history…" });
          await beat(900);
          send({ stage: "profile", profile: DEMO_PROFILE });
          send({ stage: "thinking", message: "Agent reading the building…" });
          await beat(700);

          // Replay the recorded agent trace so the offline path shows the same
          // tool calls and refinements the live one does.
          for (const step of DEMO_STEPS) {
            send({ stage: "step", step });
            await beat(step.type === "tool" ? 420 : 260);
          }

          send({ stage: "picks", picks: DEMO_PICKS });
          send({ stage: "done" });
          close();
          return;
        }

        send({ stage: "resolving", message: "Locating building…" });
        const addr = await resolveAddress(address);
        send({ stage: "address", address: addr });

        send({ stage: "records", message: "Pulling HPD violations and 311 history…" });
        const profile = await buildProfile(addr);
        send({ stage: "profile", profile });

        if (!profile.signals.length) {
          send({
            stage: "error",
            message:
              "No open violations on record for this building. Try a residential walk-up — commercial towers come back clean.",
          });
          close();
          return;
        }

        const model = selectModel();
        let picks: Pick[] | undefined;

        if (model) {
          send({ stage: "thinking", message: "Agent reading the building…" });
          try {
            picks = await runAgent(profile, model, (step) => send({ stage: "step", step }));
          } catch (e: any) {
            send({
              stage: "step",
              step: { type: "thought", text: `Agent failed (${e?.message ?? "error"}), falling back.` },
            });
          }
        }

        // A cart of one or two items reads as broken on stage, so treat a thin
        // agent result the same as no result and use the full deterministic list.
        if (!picks || picks.length < 3) {
          send({ stage: "shopping", message: "Matching against live inventory…" });
          picks = await fallbackPicks(profile);
        }

        send({ stage: "picks", picks });

        send({ stage: "done" });
      } catch (err: any) {
        send({ stage: "error", message: err?.message ?? "Something went wrong" });
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
