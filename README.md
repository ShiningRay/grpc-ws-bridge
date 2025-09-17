**gRPC WS Bridge**

一个基于 Node.js 的 WebSocket ↔ gRPC 代理，支持 unary、server streaming、client streaming、bidirectional streaming 四种调用方式。前端通过 WebSocket 与该代理通信，代理再与后端 gRPC 服务交互。

**特性**
- 支持四种 gRPC 调用：unary、server stream、client stream、bidi stream。
- 支持传递与返回 gRPC Metadata（含 `-bin` 二进制键）。
- 基于 `@grpc/grpc-js` 与 `@grpc/proto-loader` 动态加载 proto。
- 简单清晰的 JSON 协议封装，方便前端集成。

**安装**
- 需要 Node.js 18+
- 安装依赖：`npm install`

**运行**
- 基本用法：
  - `node src/index.js --ws-port 8080 --proto ./protos/your.proto --include ./protos --default-target localhost:50051`

可选参数：
- `--ws-port`：WebSocket 监听端口，默认 `8080`
- `--proto`：proto 文件路径，可多次传入
- `--include`：proto include 路径，可多次传入
- `--default-target`：默认后端 gRPC 目标 `host:port`
- `--secure`：启用 TLS。若启用，需要以下至少一个：
  - `--tls-ca` 指定根证书路径（仅校验对端）
  - 或使用系统信任（留空）

示例：
- `node src/index.js --ws-port 8080 --proto ./protos/helloworld.proto --include ./protos --default-target localhost:50051`

**WebSocket JSON 协议**

前端 → 代理（请求）：
- 打开调用（所有类型）
```
{
  "type": "start",
  "callId": "abc123",
  "method": "my.pkg.Greeter/SayHello", // 全限定 Service/Method
  "target": "localhost:50051",        // 可选，覆盖 default-target
  "metadata": { "authorization": "Bearer ..." }, // 可选
  "payload": { ... } // 可选，unary / server-streaming 可在 start 即发送首个请求
}
```

- 流式写入（client-streaming / bidi）
```
{
  "type": "write",
  "callId": "abc123",
  "payload": { ... }
}
```

- 结束写入（client-streaming / bidi）
```
{ "type": "end", "callId": "abc123" }
```

- 取消调用
```
{ "type": "cancel", "callId": "abc123" }
```

代理 → 前端（响应）：
- 收到响应数据（unary 返回一次，server/bidi 可能多次）：
```
{ "type": "data", "callId": "abc123", "payload": { ... } }
```

- 返回初始 Metadata（若可用）：
```
{ "type": "headers", "callId": "abc123", "metadata": { ... } }
```

- 状态结束（包含 trailers 与状态码）：
```
{
  "type": "status",
  "callId": "abc123",
  "status": {
    "code": 0,
    "details": "OK",
    "metadata": { ... } // trailers
  }
}
```

- 错误：
```
{
  "type": "error",
  "callId": "abc123",
  "error": {
    "code": 13,
    "message": "INTERNAL",
    "details": "...",
    "metadata": { ... }
  }
}
```

说明：
- Metadata 的 `-bin` 后缀键使用 base64 字符串表示二进制值；非二进制值为普通字符串或字符串数组。
- `payload` 应与对应 proto 的消息结构一致（`int64`/`uint64` 字段会以字符串表示，枚举以字符串表示）。

**实现要点**
- 使用 `@grpc/proto-loader` 的选项：`longs: String, enums: String, defaults: true, oneofs: true`，将 64 位整型序列化为字符串以避免精度问题。
- 动态根据 `Service/Method` 推断调用类型：unary / server / client / bidi，并按规则建立 gRPC 调用管道。
- 以 `callId` 关联 WebSocket 会话中的并发调用，支持多路复用。

**前端对接提示**
- 推荐为每个调用生成唯一 `callId` 并管理其生命周期（写入、结束、取消）。
- 对于 client-streaming/bidi，先发送 `start` 建立流，再使用 `write` 发送一个或多个 `payload`，最后 `end` 结束写入。

**示例与 Mock Server**
- Demo proto：`examples/protos/demo.proto`
- 启动 Mock gRPC Server（默认 :50051）：
  - `node examples/mock-server.js`
- 启动 WS Bridge（默认 :8080，指向 mock server）：
  - `node src/index.js --ws-port 8080 --proto ./examples/protos/demo.proto --include ./examples/protos --default-target localhost:50051`
- 运行 WebSocket 演示客户端（依次演示 unary/server stream/client stream/bidi）：
  - `node examples/ws-demo.js`

Demo 中包含以下 RPC：
- `demo.Greeter/SayHello`（unary）
- `demo.Greeter/GreetMany`（server streaming）
- `demo.Greeter/AccumulateGreetings`（client streaming）
- `demo.Greeter/Chat`（bidirectional streaming）
