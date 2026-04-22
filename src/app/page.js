"use client";

import { useEffect, useState } from "react";
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

  useEffect(() => {
    let cancelled = false;

    const checkAuth = async () => {
      try {
        const res = await fetch("/api/auth/me", { credentials: "include" });
        const data = await res.json();
        if (cancelled || !data?.authenticated) return;
        router.replace(data.role === "admin" ? "/admin" : "/viewer");
      } catch {
        if (!cancelled) {
          setError("");
        }
      }
    };

    const params = new URLSearchParams(window.location.search);
    if (params.get("error") === "auth") {
      setError("登录态已失效，请重新登录");
    }

    checkAuth();
    return () => {
      cancelled = true;
    };
  }, [router]);

  const handleLogin = async () => {
    if (!roomPass.trim()) {
      setError("请输入房间密码");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          roomPass: roomPass.trim(),
          adminPass: adminPass.trim(),
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data?.ok) {
        setError(data?.error || "登录失败，请稍后重试");
        return;
      }

      router.push(data.role === "admin" ? "/admin" : "/viewer");
    } catch {
      setError("无法连接到认证服务");
    } finally {
      setLoading(false);
    }
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
              {loading ? "正在登录..." : "进入房间"}
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
