"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const TIME_CHECK_INTERVAL_MS = 20000;
const DESYNC_PROMPT_THRESHOLD_SECONDS = 5;
const SYNC_TIME_THRESHOLD_SECONDS = 0.75;
const DUPLICATE_TIME_THRESHOLD_SECONDS = 0.1;

function runWithApplyGuard(applyFlagRef, action) {
  applyFlagRef.current = true;
  try {
    return Promise.resolve(action()).finally(() => {
      applyFlagRef.current = false;
    });
  } catch (error) {
    applyFlagRef.current = false;
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

function formatTime(seconds) {
  const safeSeconds = Number.isFinite(seconds) ? seconds : 0;
  const minutes = Math.floor(safeSeconds / 60);
  const remain = Math.floor(safeSeconds % 60);
  return `${minutes.toString().padStart(2, "0")}:${remain.toString().padStart(2, "0")}`;
}

export default function ViewerPage() {
  const router = useRouter();
  const playerRef = useRef(null);
  const wsRef = useRef(null);
  const isCheckingRef = useRef(false);
  const pendingCheckRef = useRef(null);
  const isApplyingSyncRef = useRef(false);
  const currentFileRef = useRef(null);
  const lastAppliedSyncRef = useRef({ file: null, time: null, playing: null });

  const [status, setStatus] = useState("正在验证观众身份...");
  const [isConnected, setIsConnected] = useState(false);
  const [showSyncDialog, setShowSyncDialog] = useState(false);

  const handleManualSync = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "requestSync" }));
      setStatus("正在请求同步...");
    } else {
      setStatus("未连接到服务器");
    }
  }, []);

  const handleFullscreenSyncPrompt = useCallback(() => {
    const pendingCheck = pendingCheckRef.current;
    if (!pendingCheck) return;

    const confirmSync = window.confirm(
      `检测到您的播放进度与主持人存在 ${pendingCheck.diff.toFixed(1)} 秒偏差，是否立即同步？`
    );

    isCheckingRef.current = false;
    pendingCheckRef.current = null;

    if (confirmSync) {
      handleManualSync();
    }
  }, [handleManualSync]);

  const handleRoleAssigned = useCallback((msg) => {
    setStatus(msg.ip ? `✅ 已连接 (IP: ${msg.ip})` : "✅ 已连接，等待主持人...");
  }, []);

  const handleTimeCheckResult = useCallback((msg, player) => {
    const localTime = player.currentTime;
    const serverTime = typeof msg.time === "number" ? msg.time : 0;
    const diff = Math.abs(localTime - serverTime);

    if (diff > DESYNC_PROMPT_THRESHOLD_SECONDS) {
      isCheckingRef.current = true;
      pendingCheckRef.current = { time: serverTime, localTime, diff };

      if (document.fullscreenElement) {
        handleFullscreenSyncPrompt();
      } else {
        setShowSyncDialog(true);
      }
    }
  }, [handleFullscreenSyncPrompt]);

  const handleAuthoritativeSyncMessage = useCallback((msg, player) => {
    const { file, time, playing } = msg;
    if (!file) return;

    const currentFile = currentFileRef.current;
    const targetTime = typeof time === "number" ? time : 0;
    const normalizedPlaying = Boolean(playing);
    const timeDiff = Math.abs(player.currentTime - targetTime);
    const shouldUpdateTime = currentFile !== file || !Number.isFinite(player.currentTime) || timeDiff > SYNC_TIME_THRESHOLD_SECONDS;
    const shouldUpdatePlayback = player.paused === normalizedPlaying;
    const lastApplied = lastAppliedSyncRef.current;
    const isDuplicateSync =
      lastApplied.file === file &&
      typeof lastApplied.time === "number" &&
      Math.abs(lastApplied.time - targetTime) < DUPLICATE_TIME_THRESHOLD_SECONDS &&
      lastApplied.playing === normalizedPlaying;

    if (currentFile !== file) {
      currentFileRef.current = file;
      lastAppliedSyncRef.current = { file, time: targetTime, playing: normalizedPlaying };
      player.src = `/videos/${encodeURIComponent(file)}`;
      bindOnceLoadedMetadata(player, () => {
        runWithApplyGuard(isApplyingSyncRef, () => applyMediaState(player, { time: targetTime, playing: normalizedPlaying }));
      });
    } else if (!isDuplicateSync || shouldUpdateTime || shouldUpdatePlayback) {
      runWithApplyGuard(isApplyingSyncRef, () => {
        if (shouldUpdateTime) {
          player.currentTime = targetTime;
        }

        if (!shouldUpdatePlayback) {
          return Promise.resolve();
        }

        return normalizedPlaying ? player.play().catch(() => {}) : Promise.resolve(player.pause());
      });
      lastAppliedSyncRef.current = { file, time: targetTime, playing: normalizedPlaying };
    }

    setStatus(`⏱ 已同步: ${formatTime(targetTime)}`);
  }, []);

  const handlePlaybackCommand = useCallback((msg, player) => {
    if (msg.type === "load") {
      currentFileRef.current = msg.file || null;
      lastAppliedSyncRef.current = { file: msg.file || null, time: null, playing: null };
      if (msg.file) {
        const nextSrc = `/videos/${encodeURIComponent(msg.file)}`;
        if (player.src !== nextSrc) {
          player.src = nextSrc;
        }
        bindOnceLoadedMetadata(player, () => {
          const latestState = lastAppliedSyncRef.current;
          if (latestState.file !== msg.file) {
            return;
          }
          runWithApplyGuard(isApplyingSyncRef, () => applyMediaState(player, {
            time: typeof latestState.time === "number" ? latestState.time : 0,
            playing: Boolean(latestState.playing),
          }));
        });
      }
      setStatus("加载视频中...");
      return;
    }

    if (isApplyingSyncRef.current) {
      return;
    }

    if (msg.type === "seek" && typeof msg.time === "number" && Number.isFinite(msg.time)) {
      player.currentTime = msg.time;
      return;
    }

    if (msg.type === "play") {
      player.play().catch(() => {});
      return;
    }

    if (msg.type === "pause") {
      player.pause();
    }
  }, []);

  const dispatchSyncMessage = useCallback((msg) => {
    const player = playerRef.current;
    if (!player) return;

    if (msg.type === "roleAssigned") {
      handleRoleAssigned(msg);
      return;
    }

    if (msg.type === "timeCheckResult") {
      handleTimeCheckResult(msg, player);
      return;
    }

    if (msg.type === "authoritativeState" || msg.type === "authoritativeSync") {
      handleAuthoritativeSyncMessage(msg, player);
      return;
    }

    if (msg.type === "noContent") {
      setStatus(`⚠️ ${msg.reason}`);
      return;
    }

    if (msg.type === "adminLeft") {
      setStatus("主持人已离线，等待重新接管...");
      return;
    }

    if (["load", "seek", "play", "pause"].includes(msg.type)) {
      handlePlaybackCommand(msg, player);
    }
  }, [handleAuthoritativeSyncMessage, handlePlaybackCommand, handleRoleAssigned, handleTimeCheckResult]);

  useEffect(() => {
    let cancelled = false;
    let activeWs = null;

    const initializePage = async () => {
      try {
        const authRes = await fetch("/api/auth/me", { credentials: "include" });
        const authData = await authRes.json();

        if (!authData?.authenticated) {
          router.replace("/?error=auth");
          return;
        }

        activeWs = new WebSocket(`${process.env.NEXT_PUBLIC_WS_URL}/sync`);
        wsRef.current = activeWs;

        activeWs.onopen = () => {
          if (cancelled) return;
          setIsConnected(true);
          setStatus("已连接，等待主持人...");
        };

        activeWs.onmessage = (event) => {
          const msg = JSON.parse(event.data.toString());
          dispatchSyncMessage(msg);
        };

        activeWs.onclose = (event) => {
          if (cancelled) return;
          setIsConnected(false);
          if (event.code === 4000 || event.code === 4001) {
            router.replace("/?error=auth");
            return;
          }
          if (event.code !== 1000) {
            setStatus("连接断开，尝试重连...");
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

    initializePage();

    return () => {
      cancelled = true;
      const player = playerRef.current;
      if (player) {
        player.onloadedmetadata = null;
      }
      activeWs?.close();
      wsRef.current = null;
    };
  }, [dispatchSyncMessage, router]);

  useEffect(() => {
    const checkInterval = window.setInterval(() => {
      if (
        !wsRef.current ||
        wsRef.current.readyState !== WebSocket.OPEN ||
        !playerRef.current?.duration ||
        isCheckingRef.current
      ) {
        return;
      }

      wsRef.current.send(JSON.stringify({ type: "checkTime" }));
    }, TIME_CHECK_INTERVAL_MS);

    return () => window.clearInterval(checkInterval);
  }, []);

  const handleDialogConfirm = () => {
    setShowSyncDialog(false);
    isCheckingRef.current = false;
    pendingCheckRef.current = null;
    handleManualSync();
  };

  const handleDialogCancel = () => {
    setShowSyncDialog(false);
    isCheckingRef.current = false;
    pendingCheckRef.current = null;
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement && playerRef.current) {
      playerRef.current.requestFullscreen();
      return;
    }
    document.exitFullscreen();
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
      <Dialog
        open={showSyncDialog}
        onOpenChange={(open) => {
          if (!open) {
            handleDialogCancel();
          }
        }}
      >
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>⚠️ 播放进度不一致</DialogTitle>
            <DialogDescription>
              检测到您的播放进度与主持人存在超过 5 秒的偏差，是否立即同步？
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={handleDialogCancel}>不同步</Button>
            <Button type="submit" onClick={handleDialogConfirm}>立即同步</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="w-full max-w-4xl space-y-4">
        <div className="flex justify-between items-center">
          <h1 className="text-2xl font-bold">云阁 私人同步影院</h1>
          <div className="flex items-center gap-2">
            <span className={`sync-indicator ${isConnected ? "active" : ""}`}></span>
            <Badge variant="secondary">观众</Badge>
            <Button variant="outline" size="sm" onClick={handleLogout}>退出登录</Button>
          </div>
        </div>

        <Alert variant="default" className="bg-yellow-50 border-yellow-400 dark:bg-yellow-900/20 dark:border-yellow-600">
          <AlertTitle>👥 观众模式</AlertTitle>
          <AlertDescription>
            播放进度由主持人精准控制。如果发现进度不一致，可点击“手动同步”按钮。
          </AlertDescription>
        </Alert>

        <div className="bg-black rounded-lg overflow-hidden shadow-lg relative">
          <video ref={playerRef} className="w-full aspect-video" playsInline />
        </div>

        <div className="flex justify-center gap-4">
          <Button variant="outline" onClick={() => playerRef.current?.play()}>播放</Button>
          <Button variant="outline" onClick={() => playerRef.current?.pause()}>暂停</Button>
          <Button variant="outline" onClick={toggleFullscreen}>⛶ 全屏</Button>
          <Button
            variant="outline"
            className="border-purple-500 text-purple-600 hover:bg-purple-50 dark:hover:bg-purple-900/20"
            onClick={handleManualSync}
          >
            手动同步
          </Button>
        </div>

        <div className="text-center text-sm text-muted-foreground">{status}</div>
      </div>
    </div>
  );
}
