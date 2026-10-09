import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import path from "node:path";

import dotenv from "dotenv";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import realtimeConfig from "../shared/realtime-config.json" with { type: "json" };

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(rootDir, ".env.local"), quiet: true });

const PORT = Number(process.env.TOKEN_SERVER_PORT ?? 8787);
const MODEL = realtimeConfig.model;
const REALTIME_URL = `wss://api.openai.com/v1/realtime?model=${MODEL}`;
const SAMPLE_RATE = realtimeConfig.session.audio.input.format.rate;
const STREAM_TTL_MS = 30_000;
const DIAGNOSTIC_PROBE_TTL_MS = 60_000;
const DIAGNOSTIC_RECORDING_MAX_BYTES = 2 * 1024 * 1024;

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("Missing OPENAI_API_KEY. Add it to .env.local in the repo root.");
  process.exit(1);
}

const ffmpegAvailable = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
if (!ffmpegAvailable) {
  console.error("ffmpeg is unavailable. Expo Audio relay streams cannot start.");
}

const sessionConfig = {
  ...realtimeConfig.session,
  instructions:
    "You are a concise voice assistant in a technical demo. Keep answers to one or two short sentences unless asked for detail.",
};

const app = express();
const streams = new Map();
const diagnosticProbes = new Map();

app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  next();
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, model: MODEL, ffmpegAvailable });
});

app.get("/token", async (_req, res) => {
  try {
    const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "OpenAI-Safety-Identifier": "aec-workshop-poc",
      },
      body: JSON.stringify({ session: { ...sessionConfig, model: MODEL } }),
    });
    const data = await response.json();

    if (!response.ok) {
      console.error("client_secrets failed", response.status, data);
      res.status(response.status).json({ error: data?.error?.message ?? "Failed to mint token" });
      return;
    }

    res.json({ value: data.value, expires_at: data.expires_at, model: MODEL });
  } catch (error) {
    console.error("Token generation error:", error);
    res.status(500).json({ error: "Failed to mint token" });
  }
});

app.get("/voice-stream/:id.aac", (req, res) => {
  const stream = streams.get(req.params.id);
  if (!stream) {
    res.status(404).end();
    return;
  }

  res.status(200);
  res.setHeader("Content-Type", "audio/aac");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Transfer-Encoding", "chunked");
  res.flushHeaders();
  stream.attach(res);
});

app.post("/aec-probe/start", (req, res) => {
  const id = randomUUID();
  const source = createProbePcm();
  diagnosticProbes.set(id, { source });
  const expiry = setTimeout(() => diagnosticProbes.delete(id), DIAGNOSTIC_PROBE_TTL_MS);
  expiry.unref();
  res.json({
    id,
    url: `http://${req.headers.host}/aec-probe/${id}.aac`,
    durationMs: 3_000,
  });
});

app.get("/aec-probe/:id.aac", (req, res) => {
  const probe = diagnosticProbes.get(req.params.id);
  if (!probe) {
    res.status(404).end();
    return;
  }

  res.status(200);
  res.setHeader("Content-Type", "audio/aac");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Transfer-Encoding", "chunked");
  res.flushHeaders();
  const stream = new ProgressiveAacStream(() => {});
  stream.attach(res);
  stream.write(probe.source);
  stream.end();
});

app.put(
  "/aec-probe/:id/capture/:source",
  express.raw({ type: "application/octet-stream", limit: DIAGNOSTIC_RECORDING_MAX_BYTES }),
  async (req, res) => {
    const probe = diagnosticProbes.get(req.params.id);
    if (!probe) {
      res.status(404).json({ error: "Probe expired" });
      return;
    }
    if (!["mic", "voice_communication"].includes(req.params.source)) {
      res.status(400).json({ error: "Unsupported recording source" });
      return;
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: "Expected a binary recording" });
      return;
    }

    diagnosticProbes.delete(req.params.id);
    try {
      const captured = await decodeRecordingToPcm(req.body);
      res.json({
        source: req.params.source,
        capturedMs: Math.round((captured.length / 2 / SAMPLE_RATE) * 1_000),
        ...correlationResult(probe.source, captured),
      });
    } catch (error) {
      console.error("AEC diagnostic decode failed:", error);
      res.status(422).json({ error: "Could not decode diagnostic recording" });
    }
  }
);

function send(socket, event) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(event));
  }
}

class ProgressiveAacStream {
  constructor(onClosed) {
    this.id = randomUUID();
    this.output = new PassThrough({ highWaterMark: 512 * 1024 });
    this.closed = false;
    this.inputEnded = false;
    this.response = null;
    this.onClosed = onClosed;
    this.encoder = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "s16le",
        "-ar",
        String(SAMPLE_RATE),
        "-ac",
        "1",
        "-i",
        "pipe:0",
        "-c:a",
        "aac",
        "-profile:a",
        "aac_low",
        "-b:a",
        "64k",
        "-f",
        "adts",
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] }
    );

    this.encoder.stdout.pipe(this.output);
    this.encoder.stderr.on("data", (chunk) => {
      console.warn(`ffmpeg ${this.id}:`, chunk.toString().trim());
    });
    this.encoder.on("error", (error) => {
      console.error(`ffmpeg ${this.id} failed:`, error);
      this.close();
    });
    this.encoder.on("close", () => this.close());
  }

  attach(response) {
    if (this.response) {
      response.status(409).end();
      return;
    }
    this.response = response;
    this.output.pipe(response);
    response.on("close", () => {
      this.output.unpipe(response);
      this.response = null;
    });
  }

  write(pcm) {
    if (!this.closed && this.encoder.stdin.writable) {
      this.encoder.stdin.write(pcm);
    }
  }

  end() {
    if (!this.closed && this.encoder.stdin.writable) {
      this.inputEnded = true;
      this.encoder.stdin.end();
    }
  }

  cancel() {
    if (!this.closed) {
      this.encoder.kill("SIGTERM");
    }
    this.close();
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.output.end();
    this.onClosed(this.id);
  }
}

function createProbePcm() {
  const seconds = 3;
  const samples = SAMPLE_RATE * seconds;
  const pcm = Buffer.allocUnsafe(samples * 2);
  let state = 0x12345678;
  let filtered = 0;
  for (let index = 0; index < samples; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const normalized = state / 0xffffffff - 0.5;
    filtered = filtered * 0.94 + normalized * 0.06;
    pcm.writeInt16LE(Math.round(filtered * 0.7 * 32767), index * 2);
  }
  return pcm;
}

function correlationResult(reference, captured) {
  const stride = 8;
  const ref = [];
  const mic = [];
  for (let index = 0; index + 1 < reference.length; index += stride * 2) {
    ref.push(reference.readInt16LE(index) / 32768);
  }
  for (let index = 0; index + 1 < captured.length; index += stride * 2) {
    mic.push(captured.readInt16LE(index) / 32768);
  }

  const window = Math.min(ref.length, 3_000);
  let best = { value: 0, lagSamples: 0, dot: 0, refPower: 0 };
  for (let lag = 0; lag + window <= mic.length; lag += 1) {
    let dot = 0;
    let refPower = 0;
    let micPower = 0;
    for (let index = 0; index < window; index += 1) {
      const referenceSample = ref[index];
      const micSample = mic[lag + index];
      dot += referenceSample * micSample;
      refPower += referenceSample * referenceSample;
      micPower += micSample * micSample;
    }
    const value = refPower && micPower ? Math.abs(dot) / Math.sqrt(refPower * micPower) : 0;
    if (value > best.value) {
      best = { value, lagSamples: lag, dot, refPower };
    }
  }
  const echoGain = best.refPower ? Math.abs(best.dot / best.refPower) : 0;
  return {
    peakCorrelation: Number(best.value.toFixed(3)),
    estimatedLagMs: Math.round((best.lagSamples / (SAMPLE_RATE / stride)) * 1_000),
    echoGainDb: Number((20 * Math.log10(Math.max(echoGain, 1e-6))).toFixed(1)),
  };
}

function decodeRecordingToPcm(recording) {
  return new Promise((resolve, reject) => {
    const decoder = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-f",
        "s16le",
        "-ar",
        String(SAMPLE_RATE),
        "-ac",
        "1",
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    const output = [];
    let errorOutput = "";
    decoder.stdout.on("data", (chunk) => output.push(chunk));
    decoder.stderr.on("data", (chunk) => {
      errorOutput += chunk.toString();
    });
    decoder.on("error", reject);
    decoder.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(output));
      } else {
        reject(new Error(errorOutput || `ffmpeg exited with code ${String(code)}`));
      }
    });
    decoder.stdin.end(recording);
  });
}

function openRealtime(client, request) {
  const relay = {
    client,
    request,
    realtime: null,
    activeStream: null,
    playbackStreamId: null,
    activeResponseId: null,
    receivedMicBuffers: 0,
    cancelledResponseIds: new Set(),
    closed: false,
  };

  const stopActiveStream = (reason) => {
    const stream = relay.activeStream;
    const id = relay.playbackStreamId;
    relay.activeStream = null;
    relay.playbackStreamId = null;
    stream?.cancel();
    // Encoding can finish before the phone drains its playback buffer.
    if (id) {
      send(client, { type: "audio.stop", id, reason, at: Date.now() });
    }
  };

  const createAudioStream = (responseId = null) => {
    stopActiveStream("replaced");
    const stream = new ProgressiveAacStream((id) => {
      if (relay.activeStream?.id === id) {
        relay.activeStream = null;
      }
      const expiry = setTimeout(() => streams.delete(id), STREAM_TTL_MS);
      expiry.unref();
    });
    stream.responseId = responseId;
    streams.set(stream.id, stream);
    relay.activeStream = stream;
    relay.playbackStreamId = stream.id;
    send(client, {
      type: "audio.start",
      id: stream.id,
      url: `http://${request.headers.host}/voice-stream/${stream.id}.aac`,
      at: Date.now(),
    });
    return stream;
  };

  const realtime = new WebSocket(REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Safety-Identifier": "aec-workshop-poc",
    },
  });
  relay.realtime = realtime;

  const statsTimer = setInterval(() => {
    send(client, { type: "relay.stats", receivedMicBuffers: relay.receivedMicBuffers });
  }, 1_000);
  statsTimer.unref();

  realtime.on("open", () => {
    realtime.send(JSON.stringify({ type: "session.update", session: sessionConfig }));
  });

  realtime.on("message", (raw) => {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (event.type) {
      case "response.created": {
        const responseId = event.response?.id;
        if (responseId) {
          relay.activeResponseId = responseId;
        }
        return;
      }
      case "response.output_audio.delta":
      case "response.audio.delta": {
        if (!event.delta) {
          return;
        }
        const responseId = event.response_id ?? null;
        if (responseId && relay.cancelledResponseIds.has(responseId)) {
          return;
        }
        if (responseId) {
          relay.activeResponseId = responseId;
        }
        const stream =
          relay.activeStream?.responseId === responseId &&
          !relay.activeStream.inputEnded
            ? relay.activeStream
            : createAudioStream(responseId);
        stream.write(Buffer.from(event.delta, "base64"));
        return;
      }
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta":
      case "response.output_text.delta":
        if (event.delta) {
          send(client, { type: "transcript", role: "assistant", id: event.item_id, delta: event.delta });
        }
        return;
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
      case "response.output_text.done":
        send(client, {
          type: "transcript.done",
          role: "assistant",
          id: event.item_id,
          text: event.transcript ?? event.text,
        });
        return;
      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript?.trim()) {
          send(client, {
            type: "transcript.done",
            role: "user",
            id: event.item_id,
            text: event.transcript,
          });
          realtime.send(JSON.stringify({ type: "response.create" }));
        } else if (event.item_id) {
          realtime.send(JSON.stringify({ type: "conversation.item.delete", item_id: event.item_id }));
        }
        return;
      case "input_audio_buffer.speech_started":
        stopActiveStream("barge-in");
        if (relay.activeResponseId && realtime.readyState === WebSocket.OPEN) {
          relay.cancelledResponseIds.add(relay.activeResponseId);
          relay.activeResponseId = null;
          realtime.send(JSON.stringify({ type: "response.cancel" }));
        }
        send(client, { type: "speech", active: true, at: Date.now() });
        return;
      case "input_audio_buffer.speech_stopped":
        send(client, { type: "speech", active: false, at: Date.now() });
        return;
      case "response.done":
        if (event.response?.id) {
          relay.cancelledResponseIds.delete(event.response.id);
          if (relay.activeResponseId === event.response.id) {
            relay.activeResponseId = null;
          }
        }
        if (
          relay.activeStream &&
          (!event.response?.id || relay.activeStream.responseId === event.response.id)
        ) {
          relay.activeStream.end();
        }
        return;
      case "error":
        if (event.error?.message === "Cancellation failed: no active response found") {
          console.warn("Realtime cancel arrived after the response completed; continuing session.");
          return;
        }
        send(client, { type: "error", message: event.error?.message ?? "Realtime API error" });
        return;
      case "session.updated":
        send(client, { type: "relay.ready", at: Date.now() });
        return;
      default:
        return;
    }
  });

  realtime.on("error", (error) => {
    console.error("Realtime socket error:", error);
    send(client, { type: "error", message: "Realtime relay connection failed" });
  });

  realtime.on("close", (code, reason) => {
    if (!relay.closed) {
      send(client, { type: "relay.closed", code, reason: reason.toString() });
    }
  });

  client.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.type === "audio" && typeof message.data === "string") {
      const pcm = Buffer.from(message.data, "base64");
      if (pcm.length > 0 && pcm.length <= 64 * 1024 && realtime.readyState === WebSocket.OPEN) {
        realtime.send(JSON.stringify({ type: "input_audio_buffer.append", audio: message.data }));
        relay.receivedMicBuffers += 1;
      }
      return;
    }

    if (message.type === "text" && typeof message.text === "string" && realtime.readyState === WebSocket.OPEN) {
      const text = message.text.trim();
      if (!text) {
        return;
      }
      send(client, { type: "transcript.done", role: "user", id: `local-${Date.now()}`, text });
      realtime.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
        })
      );
      realtime.send(JSON.stringify({ type: "response.create" }));
      return;
    }

    if (message.type === "metric") {
      const serverAt = Date.now();
      console.log(`relay metric ${String(message.name)} turn=${String(message.id ?? "--")} client=${String(message.at)} server=${serverAt}`);
    }
  });

  client.on("close", () => {
    relay.closed = true;
    clearInterval(statsTimer);
    stopActiveStream("client-disconnect");
    realtime.close();
  });
}

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Token server on http://0.0.0.0:${PORT} (model ${MODEL})`);
  console.log(`Expo Audio relay: ws://<your-mac-lan-ip>:${PORT}/voice`);
});

const websocketServer = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (pathname !== "/voice" || !ffmpegAvailable) {
    socket.destroy();
    return;
  }
  websocketServer.handleUpgrade(request, socket, head, (client) => openRealtime(client, request));
});
