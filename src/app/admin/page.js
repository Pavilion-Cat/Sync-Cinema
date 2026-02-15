"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export default function AdminPage() {
  const router = useRouter();
  const playerRef = useRef(null);
  const wsRef = useRef(null);
  
  // 使用 ref 存储当前文件名，确保心跳定时器能拿到最新值
  const currentFileRef = useRef(null);
  
  const [status, setStatus] = useState("等待连接...");
  const [videos, setVideos] = useState([]);
  // 这里的 state 仅用于 UI 显示，逻辑判断用 ref
  const [currentFile, setCurrentFile] = useState(null); 
  const [isConnected, setIsConnected] = useState(false);
  
  const isSyncing = useRef(false);

  const fetchVideos = async () => {
    try {
      const res = await fetch('/api/videos');
      const data = await res.json();
      setVideos(data);
      setStatus("✅ 视频列表已刷新");
    } catch (err) {
      console.error(err);
      setStatus("❌ 刷新视频列表失败");
    }
  };

  useEffect(() => {
    const roomPass = sessionStorage.getItem("roomPass");
    const adminPass = sessionStorage.getItem("adminPass");
    const isAdmin = sessionStorage.getItem("isAdmin") === 'true';

    if (!roomPass || isAdmin === false) {
      router.push("/");
      return;
    }

    // 获取视频列表
    fetch('/api/videos')
      .then(res => res.json())
      .then(setVideos)
      .catch(console.error);

    // 连接 WebSocket
    const wsUrl = `${process.env.NEXT_PUBLIC_WS_URL}/sync?pass=${encodeURIComponent(roomPass)}&adminPass=${encodeURIComponent(adminPass || '')}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      setStatus("✅ 已连接");
      
      // 启动心跳定时器 (每 20 秒发送一次)
      const heartbeatTimer = setInterval(() => {
        const player = playerRef.current;
        // 确保连接正常且视频已加载
        if (ws.readyState === WebSocket.OPEN && player && player.readyState >= 2 && currentFileRef.current) {
          ws.send(JSON.stringify({
            type: 'heartbeat',
            file: currentFileRef.current,
            time: player.currentTime,
            playing: !player.paused
          }));
        }
      }, 20000); // 20秒间隔
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data.toString());

      if (msg.type === 'roleAssigned' && msg.ip) {
        setStatus(`✅ 已连接 (IP: ${msg.ip})`);
      }

      if (msg.type === 'roleAssigned' && !msg.isAdmin) {
        alert("主持人权限被转移，您已变为观众");
        router.push("/viewer");
      }
      if (msg.type === 'roleRevoked') {
        alert(msg.reason);
        sessionStorage.clear();
        router.push("/");
      }
      if (msg.type === 'authoritativeState') {
        syncVideoState(msg.file, msg.time, msg.playing);
      }
    };

    ws.onclose = (event) => {
      setIsConnected(false);
      if (event.code !== 1000) {
        setStatus("连接断开");
      }
    };
    
    const player = playerRef.current;
    if(player) {
      player.onplay = () => {
        if (!isSyncing.current) send({ type: 'play' });
      };
      player.onpause = () => {
        if (!isSyncing.current) send({ type: 'pause' });
      };
      player.onseeked = () => {
        if (!isSyncing.current) send({ type: 'seek', time: player.currentTime });
      };
    }

    return () => {
      ws.close();
    };
  }, [router]);

  const send = (data) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  };

  const syncVideoState = (file, time, playing) => {
    const player = playerRef.current;
    if (!player) return;

    if (file && file !== currentFileRef.current) {
      // 更新 Ref 和 State
      currentFileRef.current = file;
      setCurrentFile(file);
      
      player.src = `/videos/${encodeURIComponent(file)}`;
      player.onloadedmetadata = () => {
        player.currentTime = time || 0;
        if (playing) player.play().catch(()=>{});
      };
    } else if (file) {
      player.currentTime = time || 0;
      playing ? player.play().catch(()=>{}) : player.pause();
    }
  };

  const handleLoadVideo = (file) => {
    if (!file) return;
    // 更新 Ref 和 State
    currentFileRef.current = file;
    setCurrentFile(file);
    
    send({ type: 'load', file });
    if (playerRef.current) {
      playerRef.current.src = `/videos/${encodeURIComponent(file)}`;
    }
  };

  const handleForceSync = () => {
    // 使用 ref 获取当前文件
    if (!currentFileRef.current || !playerRef.current) return;
    send({
      type: 'forceSync',
      file: currentFileRef.current,
      time: playerRef.current.currentTime,
      playing: !playerRef.current.paused
    });
  };

  const handlePauseAll = () => {
    send({ type: 'pause' });
    if (playerRef.current) playerRef.current.pause();
  };

  return (
    <div className="min-h-screen flex flex-col items-center p-4 bg-background">
      <div className="w-full max-w-4xl space-y-4">
        <div className="flex justify-between items-center">
          <h1 className="text-2xl font-bold">云阁 私人同步影院</h1>
          <div className="flex items-center gap-2">
            <span className={`sync-indicator ${isConnected ? 'active' : ''}`}></span>
            <Badge variant="default">主持人</Badge>
          </div>
        </div>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-lg">控制面板</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2 items-end">
              <div className="flex-1"> {/* 给 Select 包一层并占满剩余空间 */}
                <Select onValueChange={handleLoadVideo}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择视频播放" />
                  </SelectTrigger>
                  <SelectContent>
                    {videos.map(v => (
                      <SelectItem key={v} value={v}>{v.replace(/\.mp4$/i, '')}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {/* 刷新按钮 */}
              <Button variant="outline" onClick={fetchVideos}>刷新视频列表</Button>
            </div>
            
            <div className="flex gap-2">
              <Button variant="destructive" onClick={handleForceSync}>强制同步所有人</Button>
              <Button variant="secondary" onClick={handlePauseAll}>暂停所有观众</Button>
            </div>
          </CardContent>
        </Card>

        <div className="bg-black rounded-lg overflow-hidden shadow-lg">
          <video 
            ref={playerRef} 
            controls 
            className="w-full aspect-video" 
          />
        </div>

        <Alert>
          <AlertTitle>主持人提示</AlertTitle>
          <AlertDescription>
            您的播放、暂停和进度调整将实时同步给所有观众。
          </AlertDescription>
        </Alert>
      </div>
    </div>
  );
}