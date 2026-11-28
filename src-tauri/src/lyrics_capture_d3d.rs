//! HWND swap chain for transparent lyrics captured by game-capture hooks.

use windows::{core::{s, Interface}, Graphics::DirectX::Direct3D11::IDirect3DDevice};
use windows::Win32::Foundation::{HMODULE, HWND};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST, ID3DBlob};
use windows::Win32::Graphics::Direct3D::Fxc::D3DCompile;
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDeviceAndSwapChain, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION,
    ID3D11ClassLinkage, ID3D11DepthStencilView, ID3D11Multithread, ID3D11PixelShader, ID3D11RenderTargetView,
    ID3D11ShaderResourceView, ID3D11VertexShader, D3D11_BIND_SHADER_RESOURCE,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, D3D11_VIEWPORT,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_MODE_DESC, DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::{
    IDXGIAdapter, IDXGIDevice, IDXGISwapChain, DXGI_PRESENT, DXGI_SWAP_CHAIN_DESC, DXGI_SWAP_CHAIN_FLAG,
    DXGI_SWAP_EFFECT_DISCARD, DXGI_USAGE_RENDER_TARGET_OUTPUT,
};
use windows::Win32::System::WinRT::Direct3D11::CreateDirect3D11DeviceFromDXGIDevice;

const ALPHA_SHADER: &[u8] = br#"
Texture2D<float4> frame : register(t0);
float4 vertex(uint id : SV_VertexID) : SV_Position {
    float2 position = float2((id << 1) & 2, id & 2);
    return float4(position * float2(2, -2) + float2(-1, 1), 0, 1);
}
float4 pixel(float4 position : SV_Position) : SV_Target {
    float4 color = frame.Load(int3(int2(position.xy), 0));
    return float4(color.a > 0 ? saturate(color.rgb / color.a) : float3(0, 0, 0), color.a);
}
"#;

fn compile_shader(vertex: bool) -> Result<ID3DBlob, String> {
    let mut code = None;
    let mut errors: Option<ID3DBlob> = None;
    unsafe {
        D3DCompile(ALPHA_SHADER.as_ptr().cast(), ALPHA_SHADER.len(), s!("lyrics-alpha"), None,
            None::<&windows::Win32::Graphics::Direct3D::ID3DInclude>,
            if vertex { s!("vertex") } else { s!("pixel") },
            if vertex { s!("vs_4_0") } else { s!("ps_4_0") }, 0, 0, &mut code, Some(&mut errors))
            .map_err(|error| {
                let detail = errors.as_ref().map(|blob| String::from_utf8_lossy(std::slice::from_raw_parts(blob.GetBufferPointer().cast::<u8>(), blob.GetBufferSize())).into_owned()).unwrap_or_default();
                format!("Compile lyrics alpha shader: {error} {detail}")
            })?;
    }
    code.ok_or_else(|| "Lyrics alpha shader is empty".to_owned())
}

pub(crate) struct CaptureSurface {
    _device: ID3D11Device,
    context: ID3D11DeviceContext,
    swap_chain: IDXGISwapChain,
    back_buffer: Option<ID3D11Texture2D>,
    width: u32,
    height: u32,
    vertex_shader: Option<ID3D11VertexShader>,
    pixel_shader: Option<ID3D11PixelShader>,
    shader_input: Option<(ID3D11Texture2D, ID3D11ShaderResourceView)>,
    render_target: Option<ID3D11RenderTargetView>,
}

// The owning render thread serializes every immediate-context operation.
unsafe impl Send for CaptureSurface {}

fn rgba_size(width: u32, height: u32) -> Result<usize, String> {
    if width == 0 || height == 0 {
        return Err("歌词采集窗口尺寸无效".into());
    }
    (width as usize)
        .checked_mul(height as usize)
        .and_then(|size| size.checked_mul(4))
        .filter(|_| width.checked_mul(4).is_some())
        .ok_or_else(|| "歌词采集画面尺寸过大".into())
}

impl CaptureSurface {
    pub(crate) fn new(hwnd: isize, width: u32, height: u32) -> Result<Self, String> {
        rgba_size(width, height)?;
        if hwnd == 0 {
            return Err("歌词采集窗口句柄无效".into());
        }
        let hwnd = HWND(hwnd as *mut std::ffi::c_void);
        let descriptor = DXGI_SWAP_CHAIN_DESC {
            BufferDesc: DXGI_MODE_DESC {
                Width: width,
                Height: height,
                Format: DXGI_FORMAT_R8G8B8A8_UNORM,
                ..Default::default()
            },
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
            BufferCount: 1,
            OutputWindow: hwnd,
            Windowed: true.into(),
            SwapEffect: DXGI_SWAP_EFFECT_DISCARD,
            Flags: 0,
        };
        let mut device = None;
        let mut context = None;
        let mut swap_chain = None;
        unsafe {
            D3D11CreateDeviceAndSwapChain(
                None::<&IDXGIAdapter>,
                D3D_DRIVER_TYPE_HARDWARE,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&descriptor),
                Some(&mut swap_chain),
                Some(&mut device),
                None,
                Some(&mut context),
            )
            .map_err(|error| format!("创建歌词游戏采集画面失败：{error}"))?;
        }
        let swap_chain = swap_chain.ok_or("未创建歌词采集交换链")?;
        let back_buffer = unsafe { swap_chain.GetBuffer(0) }.map_err(|error| error.to_string())?;
        let mut surface = Self {
            _device: device.ok_or("未创建歌词采集图形设备")?,
            context: context.ok_or("未创建歌词采集图形上下文")?,
            swap_chain,
            back_buffer: Some(back_buffer),
            width,
            height,
            vertex_shader: None,
            pixel_shader: None,
            shader_input: None,
            render_target: None,
        };
        unsafe {
            surface._device.CreateRenderTargetView(surface.back_buffer.as_ref().ok_or("Lyrics swapchain is not ready")?, None, Some(&mut surface.render_target)).map_err(|error| error.to_string())?;
            surface.context.ClearRenderTargetView(surface.render_target.as_ref().ok_or("Lyrics render target is not ready")?, &[0.0; 4]);
            surface.swap_chain.Present(0, DXGI_PRESENT(0)).ok().map_err(|error| error.to_string())?;
        }
        Ok(surface)
    }

    pub(crate) fn resize(&mut self, width: u32, height: u32) -> Result<(), String> {
        rgba_size(width, height)?;
        if self.width == width && self.height == height && self.back_buffer.is_some() {
            return Ok(());
        }
        self.back_buffer = None;
        self.render_target = None;
        self.shader_input = None;
        unsafe {
            self.context.ClearState();
            self.swap_chain.ResizeBuffers(1, width, height, DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_SWAP_CHAIN_FLAG(0))
                .map_err(|error| format!("调整歌词采集尺寸失败：{error}"))?;
            self.back_buffer = Some(self.swap_chain.GetBuffer(0).map_err(|error| error.to_string())?);
        }
        self.width = width;
        self.height = height;
        Ok(())
    }

    pub(crate) fn capture_device(&self) -> Result<IDirect3DDevice, String> {
        // The frame pool may use this device from its own worker thread.
        let multithread: ID3D11Multithread = self.context.cast().map_err(|error| error.to_string())?;
        unsafe { let _ = multithread.SetMultithreadProtected(true); }
        let device: IDXGIDevice = self._device.cast().map_err(|error| error.to_string())?;
        unsafe { CreateDirect3D11DeviceFromDXGIDevice(&device) }
            .and_then(|device| device.cast()).map_err(|error| error.to_string())
    }

    pub(crate) fn present_texture(&mut self, width: u32, height: u32, texture: &ID3D11Texture2D) -> Result<(), String> {
        self.resize(width, height)?;
        unsafe {
            let mut captured = D3D11_TEXTURE2D_DESC::default();
            texture.GetDesc(&mut captured);
            if captured.Width != width || captured.Height != height || captured.Format != DXGI_FORMAT_B8G8R8A8_UNORM || captured.SampleDesc.Count != 1 {
                return Err("Lyrics GPU frame format or dimensions do not match".to_owned());
            }
            if self.vertex_shader.is_none() {
                let vertex = compile_shader(true)?;
                let pixel = compile_shader(false)?;
                self._device.CreateVertexShader(std::slice::from_raw_parts(vertex.GetBufferPointer().cast::<u8>(), vertex.GetBufferSize()), None::<&ID3D11ClassLinkage>, Some(&mut self.vertex_shader)).map_err(|error| error.to_string())?;
                self._device.CreatePixelShader(std::slice::from_raw_parts(pixel.GetBufferPointer().cast::<u8>(), pixel.GetBufferSize()), None::<&ID3D11ClassLinkage>, Some(&mut self.pixel_shader)).map_err(|error| error.to_string())?;
            }
            if self.shader_input.is_none() {
                let descriptor = D3D11_TEXTURE2D_DESC {
                    Width: width, Height: height, MipLevels: 1, ArraySize: 1,
                    Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                    SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                    Usage: D3D11_USAGE_DEFAULT, BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
                    ..Default::default()
                };
                let mut input = None;
                self._device.CreateTexture2D(&descriptor, None, Some(&mut input)).map_err(|error| error.to_string())?;
                let input = input.ok_or("Lyrics GPU input texture was not created")?;
                let mut view = None;
                self._device.CreateShaderResourceView(&input, None, Some(&mut view)).map_err(|error| error.to_string())?;
                self.shader_input = Some((input, view.ok_or("Lyrics GPU input view was not created")?));
            }
            if self.render_target.is_none() {
                let buffer = self.back_buffer.as_ref().ok_or("Lyrics swapchain is not ready")?;
                self._device.CreateRenderTargetView(buffer, None, Some(&mut self.render_target)).map_err(|error| error.to_string())?;
            }
            let (input, view) = self.shader_input.as_ref().ok_or("Lyrics GPU input is not ready")?;
            self.context.PSSetShaderResources(0, Some(&[None]));
            self.context.CopyResource(input, texture);
            self.context.OMSetRenderTargets(Some(&[self.render_target.clone()]), None::<&ID3D11DepthStencilView>);
            self.context.RSSetViewports(Some(&[D3D11_VIEWPORT { Width: width as f32, Height: height as f32, MaxDepth: 1.0, ..Default::default() }]));
            self.context.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
            self.context.VSSetShader(self.vertex_shader.as_ref(), None);
            self.context.PSSetShader(self.pixel_shader.as_ref(), None);
            self.context.PSSetShaderResources(0, Some(&[Some(view.clone())]));
            self.context.Draw(3, 0);
            self.context.PSSetShaderResources(0, Some(&[None]));
            self.swap_chain.Present(0, DXGI_PRESENT(0)).ok().map_err(|error| format!("Present lyrics GPU frame: {error}"))
        }
    }

}
