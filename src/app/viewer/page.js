"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
// 引入 Dialog 组件
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export default function ViewerPage() {
  const router = useRouter();
  const playerRef = useRef(null);
  const wsRef = useRef(null);
  
  const [status, setStatus] = useState("等待连接...");
  const [isConnected, setIsConnected] = useState(false);
  
  // 状态：控制弹窗显示
  const [showSyncDialog, setShowSyncDialog] = useState(false);
  // 标记：防止在弹窗打开时重复触发检查
  const isCheckingRef = useRef(false);

  useEffect(() => {
    const roomPass = sessionStorage.getItem("roomPass");
    const adminPass = sessionStorage.getItem("adminPass");
    const isAdmin = sessionStorage.getItem("isAdmin") === 'true';

    if (isAdmin) {
      router.push("/admin");
      return;
    }
    
    if (!roomPass) {
      router.push("/");
      return;
    }

    const wsUrl = `${process.env.NEXT_PUBLIC_WS_URL}/sync?pass=${encodeURIComponent(roomPass)}&adminPass=${encodeURIComponent(adminPass || '')}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      setStatus("已连接，等待主持人...");
    };

    ws.onmessage = (event) => handleSyncMessage(JSON.parse(event.data.toString()));

    ws.onclose = (event) => {
      setIsConnected(false);
      if (event.code === 4001 || event.code === 4000) {
        sessionStorage.clear();
        router.push("/?error=auth");
      } else {
        setStatus("连接断开，尝试重连...");
      }
    };

    return () => {
      ws.close();
    };
  }, [router]);

  // 定时检查逻辑
  useEffect(() => {
    const checkInterval = setInterval(() => {
      // 如果未连接、视频未加载 或 弹窗已打开，则跳过
      if (
        !wsRef.current || 
        wsRef.current.readyState !== WebSocket.OPEN || 
        !playerRef.current?.duration ||
        isCheckingRef.current
      ) {
        return;
      }

      // 发送静默检查请求
      wsRef.current.send(JSON.stringify({ type: 'checkTime' }));
      
    }, 20000); // 20秒检查一次

    return () => clearInterval(checkInterval);
  }, []);

  const handleSyncMessage = (msg) => {
    const player = playerRef.current;
    if (!player) return;

    if (msg.type === 'roleAssigned') {
      // 如果有 IP 信息，更新状态栏显示
      if (msg.ip) {
        setStatus(`✅ 已连接 (IP: ${msg.ip})`);
      }
    }

    // 处理时间校验结果
    if (msg.type === 'timeCheckResult') {
      const { time } = msg;
      const localTime = player.currentTime;
      const diff = Math.abs(localTime - time);

      console.log(`[校验] 本地: ${localTime.toFixed(1)}s | 服务器: ${time.toFixed(1)}s | 误差: ${diff.toFixed(1)}s`);

      if (diff > 5) {
        // 误差超过5秒，锁住检查标记，弹窗
        isCheckingRef.current = true;
        setShowSyncDialog(true);
      }
      return; // 仅校验，不同步
    }

    // 处理权威状态
    if (msg.type === 'authoritativeState' || msg.type === 'authoritativeSync') {
      const { file, time, playing } = msg;
      const currentSrc = player.src ? decodeURIComponent(player.src.split('/').pop()) : null;
      
      if (file && currentSrc !== file) {
        player.src = `/videos/${encodeURIComponent(file)}`;
        player.onloadedmetadata = () => {
          player.currentTime = time || 0;
          if (playing) player.play().catch(()=>{});
          else player.pause();
        };
      } else if (file) {
        player.currentTime = time || 0;
        playing ? player.play().catch(()=>{}) : player.pause();
      }
      setStatus(`⏱ 已同步: ${formatTime(time || 0)}`);
    }
    
    if (msg.type === 'noContent') {
      setStatus("⚠️ " + msg.reason);
    }
    
    if (msg.type === 'load') {
      player.src = `/videos/${encodeURIComponent(msg.file)}`;
      setStatus("加载视频中...");
    }
    if (msg.type === 'seek') {
      player.currentTime = msg.time;
    }
    if (msg.type === 'play') {
      player.play().catch(()=>{});
    }
    if (msg.type === 'pause') {
      player.pause();
    }
  };

  // 手动同步按钮逻辑
  const handleManualSync = () => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'requestSync' }));
      setStatus("正在请求同步...");
    } else {
      setStatus("未连接到服务器");
    }
  };

  // 弹窗确认同步逻辑
  const handleDialogConfirm = () => {
    setShowSyncDialog(false);
    isCheckingRef.current = false; // 解锁检查
    handleManualSync(); // 触发真正的同步
  };

  // 弹窗取消逻辑
  const handleDialogCancel = () => {
    setShowSyncDialog(false);
    isCheckingRef.current = false; // 解锁检查
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement && playerRef.current) {
      playerRef.current.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  };

  const formatTime = (seconds) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="min-h-screen flex flex-col items-center p-4 bg-background">
      {/* 同步提示弹窗 */}
      <Dialog open={showSyncDialog} onOpenChange={(open) => {
        // 点击遮罩层关闭时也触发取消逻辑
        if(!open) handleDialogCancel();
      }}>
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
            <span className={`sync-indicator ${isConnected ? 'active' : ''}`}></span>
            <Badge variant="secondary">观众</Badge>
          </div>
        </div>

        <Alert variant="default" className="bg-yellow-50 border-yellow-400 dark:bg-yellow-900/20 dark:border-yellow-600">
          <AlertTitle>👥 观众模式</AlertTitle>
          <AlertDescription>
            播放进度由主持人精准控制。如果发现进度不一致，可点击“手动同步”按钮。
          </AlertDescription>
        </Alert>

        <div className="bg-black rounded-lg overflow-hidden shadow-lg relative">
          <video 
            ref={playerRef} 
            className="w-full aspect-video" 
            playsInline
          />
        </div>

        <div className="flex justify-center gap-4">
          <Button variant="outline" onClick={()=> playerRef.current?.play()}>播放</Button>
          <Button variant="outline" onClick={()=> playerRef.current?.pause()}>暂停</Button>
          <Button variant="outline" onClick={toggleFullscreen}>⛶ 全屏</Button>
          <Button 
            variant="outline" 
            className="border-purple-500 text-purple-600 hover:bg-purple-50 dark:hover:bg-purple-900/20"
            onClick={handleManualSync}
          >
            手动同步
          </Button>
        </div>
        
        <div className="text-center text-sm text-muted-foreground">
          {status}
        </div>
      </div>
    </div>
  );
}