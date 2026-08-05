# 数据模型

## Asset

保存 UUID、名称、最终描述、媒体类型、原文件名/相对路径/MIME/大小、直接入库标志、处理状态、审核状态、失败信息、可空的来源批次 ID 和审计时间。普通素材没有来源批次；分镜素材通过来源批次取得 `sourceOriginalFilename`，不在 Asset 中重复保存分镜序号或时间范围。

## VideoSceneBatch

表示一次原视频分镜上传。保存上传 UUID、原文件名、处理期间使用的原文件相对路径、原文件大小、直接入库标志、分镜批次状态、分镜数量、失败码/说明、可空软删除时间和审计时间。

- 状态为 `queued`、`splitting`、`validating_segments`、`analyzing`、`completed` 或 `failed`。
- 一个批次可关联多个 Asset；Asset 最多关联一个批次。
- 原文件在全部分镜下载到素材库或批次终态失败后删除，并将原文件路径清空；批次记录和原文件名长期保留。
- 外部分镜任务 ID 只用于运行期间的清理和恢复，不作为公开来源信息。
- 批次失败不提供显式重试，用户必须重新上传原视频。
- 未软删除的失败批次作为 `failed_scene_batch` 概览项合并进待入库分页；它不是 Asset、没有媒体预览或详情页。删除操作只设置批次软删除时间并终止残留队列任务。

## UploadRequest

与 Asset 一对一，保存上传 UUID、客户端文件名、声明 MIME、大小和创建时间。

## ProcessingJob

与 Asset 多对一，类型为 `analyze` 或 `cleanup`，包含队列状态、尝试次数、可执行时间、抢占时间和审计时间。

## VideoSceneBatchJob

与 VideoSceneBatch 多对一，负责切分、完整清单校验、分片下载、子素材创建和批次协调。包含队列状态、尝试次数、可执行时间、抢占时间、当前阶段和审计时间。worker 恢复失联任务时必须按批次与分镜文件的稳定标识幂等继续，禁止重复创建子素材。

## AnalysisResult

与 Asset 一对一，保存版本化 JSON、模型协议、模型名和完成时间。JSON 必须满足 `ImageAnalysis` 或 `VideoAnalysis` 的 Zod 契约。

## VideoFrameManifest（文件系统派生物）

视频素材目录中的 `frames/manifest.json` 保存原视频时长、1–5 个 JPEG 帧文件名及对应时间点。它不单独写入数据库；分析重试从该清单复用关键帧，软删除后的 cleanup 任务随素材目录一并移除。

## Tag / AssetTag / AssetTagRejection

Tag 以分类和规范化值唯一；AssetTag 记录 `model` 或 `human` 来源。AssetTagRejection 记录用户明确删除的模型标签，后续重试不得恢复。

## 状态转换

单素材：

```text
queued → validating → analyzing → completed
任一非终态 → failed
failed → queued（显式重试）
completed + directPublish → published
completed + 人工确认 → published
pending_review / published → deleted → cleanup
```

分镜批次：

```text
queued → splitting → validating_segments
validating_segments + 任一分镜 > 7 MiB → failed(file_too_large)，不创建 Asset
validating_segments + 全部分镜合格 → 原子创建全部 Asset → analyzing
analyzing + 全部 Asset 分析成功 → completed
analyzing + 任一 Asset 分析失败 → 整批 Asset deleted → cleanup → failed
```

批次选择直接入库时，所有子素材分析成功后在同一事务中转为 `published`；否则统一保持 `pending_review`。批次进入终态前，关联 Asset 不允许单独发布、重试或删除；批次成功后按普通素材管理。
