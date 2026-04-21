---
description: Automated Video Generation Workflow using MCP
---

# Workflow: Tạo video tự động từ Script

Quy trình này hướng dẫn Agent cách tạo một video hoàn chỉnh từ kịch bản (script) ban đầu, sử dụng kết nối MCP với `workflow-space-ultra`.

## Các Bước Thực Hiện

1. **Phân tích yêu cầu và kịch bản (Script)**
   - Đọc kịch bản/nội dung mà người dùng cung cấp.
   - Trích xuất ý tưởng chính để viết 2 loại prompt:
     - **Image Prompt**: Prompt mô tả hình ảnh dùng để tạo ảnh gốc (start frame).
     - **Video Prompt**: Prompt mô tả chuyển động (motion) cho video dựa trên bức ảnh gốc đó.

2. **Tạo ảnh nền (Tạo Image từ Text)**
   - Sử dụng tool `mcp_workflow-space-ultra_gen_image`.
   - Chú ý: Đây là ảnh đầu tiên đóng vai trò làm khung hình bắt đầu cho video (start image).
   - Truyền vào các tham số cần thiết:
     - `prompt`: Image Prompt đã tạo ở Bước 1.
     - `modelLabel`: 'Nano Banana 2' hoặc 'Imagen 4' (hoặc theo ngữ cảnh).
     - `aspectRatio`: 16:9, 9:16 hoặc 1:1.
   - Lấy URL hoặc ID kết quả trả về từ output của tool.

3. **Kiểm tra trạng thái xác thực (Nếu cần)**
   - Nếu output báo chưa log in (ví dụ: cần auth provider), sử dụng tool `mcp_workflow-space-ultra_auth_status` hoặc `mcp_workflow-space-ultra_open_login` để xử lý đăng nhập với provider tương ứng (VEO / Grok).

4. **Tạo video (Image-to-Video)**
   - Sử dụng tool `mcp_workflow-space-ultra_gen_video_i2v`.
   - Chú ý đoạn lệnh này sẽ thực thi quá trình chuyển đổi bức ảnh ban đầu thành video với prompt mô tả hành động.
   - Truyền vào các tham số:
     - `startImageUrl`: URL ảnh tạo ra từ Bước 2.
     - `prompt`: Video Prompt mô tả chuyển động.
     - `provider`: `veo` hoặc `grok`.
     - `aspectRatio`: Tương tự lúc tạo ảnh.
   - Tool sẽ block và chờ cho đến khi job xong, trả về file URL cục bộ của video. Ghi nhận URL này.

5. **Trình bày kết quả cho người dùng**
   - In ra URL của bức ảnh đã tạo.
   - In ra URL của video đã hoàn thành.
   - Sử dụng syntax markdown (ví dụ `![Kết quả Video](URL)`) nếu cần thiết để nhúng vào báo cáo.
   - Thông báo workflow đã thành công.
