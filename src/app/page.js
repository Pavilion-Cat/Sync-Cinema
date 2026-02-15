"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export default function LoginPage() {
  const router = useRouter();
  const [roomPass, setRoomPass] = useState("");
  const [adminPass, setAdminPass] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = () => {
    if (!roomPass.trim()) {
      setError("请输入房间密码");
      return;
    }
    setLoading(true);
    setError("");

    // 先尝试连接 WebSocket 进行验证（这里是后端在新加入用户时会出现一次断连日志的原因）
    const wsUrl = `${process.env.NEXT_PUBLIC_WS_URL}/sync?pass=${encodeURIComponent(roomPass)}&adminPass=${encodeURIComponent(adminPass)}`;
    const ws = new WebSocket(wsUrl);

    // 设置超时（5秒）
    const timeout = setTimeout(() => {
      ws.close();
      setError("连接超时，请检查后端服务是否启动");
      setLoading(false);
    }, 5000);

    ws.onopen = () => {
      clearTimeout(timeout);
      // 连接成功，等待服务器分配角色
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data.toString());
      
      // 收到角色分配消息，说明密码正确
      if (msg.type === 'roleAssigned') {
        // 2. 验证成功，保存状态
        sessionStorage.setItem("roomPass", roomPass);
        sessionStorage.setItem("adminPass", adminPass);
        sessionStorage.setItem("isAdmin", msg.isAdmin); // 保存角色状态

        // 3. 关闭连接并跳转
        ws.close();
        
        if (msg.isAdmin) {
          router.push("/admin");
        } else {
          router.push("/viewer");
        }
      }
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      setError("无法连接到同步服务");
      setLoading(false);
    };

    ws.onclose = (event) => {
      clearTimeout(timeout);
      setLoading(false);
      // 如果是密码错误 (后端返回 4001)
      if (event.code === 4001) {
        setError("房间密码错误");
      }
    };
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">云阁 私人同步影院</CardTitle>
          <CardDescription>与好友同步观影 · 主持人精准控制</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">房间密码</label>
              <Input
                type="password"
                placeholder="输入房间密码"
                value={roomPass}
                onChange={(e) => setRoomPass(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleLogin()}
                disabled={loading}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">主持人密码（留空则为观众）</label>
              <Input
                type="password"
                placeholder="输入主持人密码（可选）"
                value={adminPass}
                onChange={(e) => setAdminPass(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleLogin()}
                disabled={loading}
              />
            </div>
            
            {error && <p className="text-red-500 text-sm text-center">{error}</p>}
            
            <Button className="w-full" onClick={handleLogin} disabled={loading}>
              {loading ? "正在连接..." : "进入房间"}
            </Button>

            <Alert>
              <AlertTitle>角色说明</AlertTitle>
              <AlertDescription className="text-xs mt-1">
                <p>• <strong>主持人</strong>：输入主持人密码，可选择视频、控制播放进度</p>
                <p className="mt-1">• <strong>观众</strong>：仅输入房间密码，自动同步主持人操作</p>
              </AlertDescription>
            </Alert>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}