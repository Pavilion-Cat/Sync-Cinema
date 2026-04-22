"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

const HEARTBEAT_INTERVAL_MS = 20000;
const LOCAL_CONTROL_GUARD_MS = 3000;
const SYNC_TIME_THRESHOLD_SECONDS = 0.75;
const DUPLICATE_TIME_THRESHOLD_SECONDS = 0.1;

function runWithSyncGuard(syncFlagRef, action) {
  syncFlagRef.current = true;
  try {
    return Promise.resolve(action()).finally(() => {
      syncFlagRef.current = false;
    });
  } catch (error) {
    syncFlagRef.current = false;
    throw error;
  }
}

function applyMediaState(player, { time, playing }) {
  if (typeof time === "number" && Number.isFinite(time)) {
    player.currentTime = time;
  }

  return playing ? player.play().catch(() => {}) : Promise.resolve(player.pause());
}

function bindOnceLoadedMetadata(player, handler) {
  player.addEventListener("loadedmetadata", handler, { once: true });
}

export default function AdminPage() {
  const router = useRouter();
  const playerRef = useRef(null);
  const wsRef = useRef(null);
  const currentFileRef = useRef(null);
  const isSyncingRef = useRef(false);
  const suppressNextPauseRef = useRef(false);
  const ignoreAuthoritativeStateUntilRef = useRef(0);
  const lastAppliedStateRef = useRef({ file: null, time: null, playing: null });

  const [status, setStatus] = useState("正在验证主持人身份...");
  const [videos, setVideos] = useState([]);
  const [isConnected, setIsConnected] = useState(false);

  const send = (data) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  };

  const beginLocalControlWindow = (duration = LOCAL_CONTROL_GUARD_MS) => {
    ignoreAuthoritativeStateUntilRef.current = Date.now() + duration;
  };

  const syncVideoState = (file, time, playing) => {
    const player = playerRef.current;
    if (!player || !file) return;

    const targetTime = typeof time === "number" ? time : 0;
    const normalizedPlaying = Boolean(playing);
    const lastApplied = lastAppliedStateRef.current;
    const isSameFile = file === currentFileRef.current;
    const currentDiff = Math.abs(player.currentTime - targetTime);
    const shouldUpdateTime = !isSameFile || !Number.isFinite(player.currentTime) || currentDiff > SYNC_TIME_THRESHOLD_SECONDS;
    const shouldUpdatePlayback = player.paused === normalizedPlaying;
    const isDuplicateState =
      lastApplied.file === file &&
      typeof lastApplied.time === "number" &&
      Math.abs(lastApplied.time - targetTime) < DUPLICATE_TIME_THRESHOLD_SECONDS &&
      lastApplied.playing === normalizedPlaying;

    if (isDuplicateState && !shouldUpdateTime && !shouldUpdatePlayback) {
      return;
    }

    if (!isSameFile) {
      currentFileRef.current = file;
      lastAppliedStateRef.current = { file, time: targetTime, playing: normalizedPlaying };
      player.src = `/videos/${encodeURIComponent(file)}`;
      bindOnceLoadedMetadata(player, () => {
        runWithSyncGuard(isSyncingRef, () => applyMediaState(player, { time: targetTime, playing: normalizedPlaying }));
      });
      return;
    }

    runWithSyncGuard(isSyncingRef, () => {
      if (shouldUpdateTime) {
        player.currentTime = targetTime;
      }

      if (!shouldUpdatePlayback) {
        return Promise.resolve();
      }

      return normalizedPlaying ? player.play().catch(() => {}) : Promise.resolve(player.pause());
    });

    lastAppliedStateRef.current = { file, time: targetTime, playing: normalizedPlaying };
  };

  const fetchVideos = async () => {
    try {
      const res = await fetch("/api/videos", { credentials: "include" });
      if (!res.ok) {
        throw new Error("获取视频列表失败");
      }
      const data = await res.json();
      setVideos(Array.isArray(data) ? data : []);
      setStatus((prev) => (prev.startsWith("✅ 已连接") ? prev : "✅ 视频列表已刷新"));
    } catch (error) {
      console.error(error);
      setStatus("❌ 刷新视频列表失败");
    }
  };

  const handleWebSocketMessage = (msg) => {
    if (msg.type === "roleAssigned") {
      if (!msg.isAdmin) {
        alert("主持人权限被转移，您已变为观众");
        router.replace("/viewer");
        return;
      }

      setStatus(msg.ip ? `✅ 已连接 (IP: ${msg.ip})` : "✅ 已连接");
      return;
    }

    if (msg.type === "roleRevoked") {
      alert(msg.reason || "主持人权限已失效，请重新登录");
      router.replace("/?error=auth");
      return;
    }

    if (msg.type === "authoritativeState") {
      const isDuringLocalControlWindow = Date.now() < ignoreAuthoritativeStateUntilRef.current;
      const isSameCurrentFile = msg.file && msg.file === currentFileRef.current;
      if (isDuringLocalControlWindow && isSameCurrentFile) {
        return;
      }
      syncVideoState(msg.file, msg.time, msg.playing);
    }
  };

  useEffect(() => {
    let cancelled = false;
    let activeWs = null;
    let heartbeatTimer = null;
    const player = playerRef.current;

    const attachPlayerEvents = () => {
      if (!player) return;

      player.onplay = () => {
        if (!isSyncingRef.current) {
          beginLocalControlWindow();
          send({ type: "play" });
        }
      };

      player.onpause = () => {
        if (suppressNextPauseRef.current) {
          suppressNextPauseRef.current = false;
          return;
        }
        if (!isSyncingRef.current) {
          beginLocalControlWindow();
          send({ type: "pause" });
        }
      };

      player.onseeked = () => {
        if (!isSyncingRef.current) {
          beginLocalControlWindow();
          send({ type: "seek", time: player.currentTime });
        }
      };
    };

    const cleanupPlayerEvents = () => {
      if (!player) return;
      player.onplay = null;
      player.onpause = null;
      player.onseeked = null;
      player.onloadedmetadata = null;
    };

    const initializePage = async () => {
      try {
        const authRes = await fetch("/api/auth/me", { credentials: "include" });
        const authData = await authRes.json();

        if (!authData?.authenticated) {
          router.replace("/?error=auth");
          return;
        }

        if (authData.role !== "admin") {
          router.replace("/viewer");
          return;
        }

        const videoRes = await fetch("/api/videos", { credentials: "include" });
        const videoData = await videoRes.json();
        if (!cancelled) {
          setVideos(Array.isArray(videoData) ? videoData : []);
        }

        activeWs = new WebSocket(`${process.env.NEXT_PUBLIC_WS_URL}/sync`);
        wsRef.current = activeWs;

        activeWs.onopen = () => {
          if (cancelled) return;
          setIsConnected(true);
          setStatus("✅ 已连接");
          heartbeatTimer = window.setInterval(() => {
            const currentPlayer = playerRef.current;
            if (
              activeWs?.readyState === WebSocket.OPEN &&
              currentPlayer &&
              currentPlayer.readyState >= 2 &&
              currentFileRef.current
            ) {
              activeWs.send(JSON.stringify({
                type: "heartbeat",
                file: currentFileRef.current,
                time: currentPlayer.currentTime,
                playing: !currentPlayer.paused,
              }));
            }
          }, HEARTBEAT_INTERVAL_MS);
        };

        activeWs.onmessage = (event) => {
          const msg = JSON.parse(event.data.toString());
          handleWebSocketMessage(msg);
        };

        activeWs.onclose = (event) => {
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
          }
          if (cancelled) return;
          setIsConnected(false);
          if (event.code === 4000 || event.code === 4001) {
            router.replace("/?error=auth");
            return;
          }
          if (event.code !== 1000) {
            setStatus("连接断开");
          }
        };
      } catch (error) {
        console.error(error);
        if (!cancelled) {
          setStatus("❌ 鉴权初始化失败");
          router.replace("/?error=auth");
        }
      }
    };

    attachPlayerEvents();
    initializePage();

    return () => {
      cancelled = true;
      cleanupPlayerEvents();
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      activeWs?.close();
      wsRef.current = null;
    };
  }, [router]);

  const handleLoadVideo = (file) => {
    if (!file) return;
    beginLocalControlWindow();
    currentFileRef.current = file;
    lastAppliedStateRef.current = { file, time: 0, playing: false };
    send({ type: "load", file });
    if (playerRef.current) {
      suppressNextPauseRef.current = true;
      playerRef.current.src = `/videos/${encodeURIComponent(file)}`;
    }
  };

  const handlePlayAll = () => {
    const player = playerRef.current;
    if (!currentFileRef.current || !player) return;
    beginLocalControlWindow();
    player.play().catch(() => {});
    send({ type: "play" });
  };

  const handleForceSync = () => {
    const player = playerRef.current;
    if (!currentFileRef.current || !player) return;
    beginLocalControlWindow();
    send({
      type: "forceSync",
      file: currentFileRef.current,
      time: player.currentTime,
      playing: !player.paused,
    });
  };

  const handlePauseAll = () => {
    beginLocalControlWindow();
    send({ type: "pause" });
    playerRef.current?.pause();
  };

  const handleLogout = async () => {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
      });
    } finally {
      router.replace("/");
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center p-4 bg-background">
      <div className="w-full max-w-4xl space-y-4">
        <div className="flex justify-between items-center">
          <h1 className="text-2xl font-bold">云阁 私人同步影院</h1>
          <div className="flex items-center gap-2">
            <span className={`sync-indicator ${isConnected ? "active" : ""}`}></span>
            <Badge variant="default">主持人</Badge>
            <Button variant="outline" size="sm" onClick={handleLogout}>退出登录</Button>
          </div>
        </div>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-lg">控制面板</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2 items-end">
              <div className="flex-1">
                <Select onValueChange={handleLoadVideo}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择视频播放" />
                  </SelectTrigger>
                  <SelectContent>
                    {videos.map((video) => (
                      <SelectItem key={video} value={video}>{video.replace(/\.mp4$/i, "")}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button variant="outline" onClick={fetchVideos}>刷新视频列表</Button>
            </div>

            <div className="flex gap-2 flex-wrap">
              <Button onClick={handlePlayAll}>开始播放</Button>
              <Button variant="destructive" onClick={handleForceSync}>强制同步所有人</Button>
              <Button variant="secondary" onClick={handlePauseAll}>暂停所有观众</Button>
            </div>
          </CardContent>
        </Card>

        <div className="bg-black rounded-lg overflow-hidden shadow-lg">
          <video ref={playerRef} controls className="w-full aspect-video" />
        </div>

        <Alert>
          <AlertTitle>主持人提示</AlertTitle>
          <AlertDescription>
            您的播放、暂停和进度调整将实时同步给所有观众。
          </AlertDescription>
        </Alert>

        <div className="text-center text-sm text-muted-foreground">{status}</div>
      </div>
    </div>
  );
}
