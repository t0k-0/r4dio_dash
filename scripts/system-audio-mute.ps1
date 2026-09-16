param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('get', 'mute', 'unmute', 'serve')]
  [string]$Action
)

$ErrorActionPreference = 'Stop'

if (-not ('RadioWatch.CoreAudio' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace RadioWatch {
  enum EDataFlow { Render = 0, Capture = 1, All = 2 }
  enum ERole { Console = 0, Multimedia = 1, Communications = 2 }

  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  class MMDeviceEnumeratorComObject { }

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(EDataFlow dataFlow, uint stateMask, out IntPtr devices);
    [PreserveSig] int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice device);
    [PreserveSig] int GetDevice(string id, out IMMDevice device);
    [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
    [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
  }

  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, uint classContext, IntPtr activationParameters, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
    [PreserveSig] int OpenPropertyStore(uint access, out IntPtr properties);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetState(out uint state);
  }

  [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioEndpointVolume {
    [PreserveSig] int RegisterControlChangeNotify(IntPtr notify);
    [PreserveSig] int UnregisterControlChangeNotify(IntPtr notify);
    [PreserveSig] int GetChannelCount(out uint channelCount);
    [PreserveSig] int SetMasterVolumeLevel(float levelDb, Guid eventContext);
    [PreserveSig] int SetMasterVolumeLevelScalar(float level, Guid eventContext);
    [PreserveSig] int GetMasterVolumeLevel(out float levelDb);
    [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
    [PreserveSig] int SetChannelVolumeLevel(uint channel, float levelDb, Guid eventContext);
    [PreserveSig] int SetChannelVolumeLevelScalar(uint channel, float level, Guid eventContext);
    [PreserveSig] int GetChannelVolumeLevel(uint channel, out float levelDb);
    [PreserveSig] int GetChannelVolumeLevelScalar(uint channel, out float level);
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool muted, Guid eventContext);
    [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool muted);
    [PreserveSig] int GetVolumeStepInfo(out uint step, out uint stepCount);
    [PreserveSig] int VolumeStepUp(Guid eventContext);
    [PreserveSig] int VolumeStepDown(Guid eventContext);
    [PreserveSig] int QueryHardwareSupport(out uint hardwareSupportMask);
    [PreserveSig] int GetVolumeRange(out float minDb, out float maxDb, out float incrementDb);
  }

  public static class CoreAudio {
    static readonly object EndpointLock = new object();
    static IAudioEndpointVolume cachedEndpoint;

    static IAudioEndpointVolume OpenDefaultOutput() {
      IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
      IMMDevice device = null;
      object endpointObject = null;
      try {
        Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(EDataFlow.Render, ERole.Multimedia, out device));
        Guid endpointVolumeId = typeof(IAudioEndpointVolume).GUID;
        Marshal.ThrowExceptionForHR(device.Activate(ref endpointVolumeId, 23, IntPtr.Zero, out endpointObject));
        return (IAudioEndpointVolume)endpointObject;
      } finally {
        if (device != null) Marshal.ReleaseComObject(device);
        Marshal.ReleaseComObject(enumerator);
      }
    }

    static IAudioEndpointVolume GetEndpoint() {
      if (cachedEndpoint == null) cachedEndpoint = OpenDefaultOutput();
      return cachedEndpoint;
    }

    static void DropEndpoint() {
      if (cachedEndpoint == null) return;
      try { Marshal.ReleaseComObject(cachedEndpoint); } catch { }
      cachedEndpoint = null;
    }

    public static bool GetMute() {
      lock (EndpointLock) {
        for (int attempt = 0; attempt < 2; attempt++) {
          bool muted;
          int result = GetEndpoint().GetMute(out muted);
          if (result >= 0) return muted;
          DropEndpoint();
          if (attempt > 0) Marshal.ThrowExceptionForHR(result);
        }
        return false;
      }
    }

    public static bool SetMute(bool muted) {
      lock (EndpointLock) {
        for (int attempt = 0; attempt < 2; attempt++) {
          IAudioEndpointVolume endpoint = GetEndpoint();
          int result = endpoint.SetMute(muted, Guid.Empty);
          bool actual = muted;
          if (result >= 0) result = endpoint.GetMute(out actual);
          if (result >= 0) return actual;
          DropEndpoint();
          if (attempt > 0) Marshal.ThrowExceptionForHR(result);
        }
        return muted;
      }
    }

    public static void Close() {
      lock (EndpointLock) { DropEndpoint(); }
    }
  }
}
'@
}

function Invoke-RadioWatchAudioAction([string]$RequestedAction) {
  switch ($RequestedAction) {
    'get' { return [RadioWatch.CoreAudio]::GetMute() }
    'mute' { return [RadioWatch.CoreAudio]::SetMute($true) }
    'unmute' { return [RadioWatch.CoreAudio]::SetMute($false) }
  }
}

if ($Action -eq 'serve') {
  $bridgeOwnsMute = $false
  $bridgePriorMuted = $false
  try {
    while ($null -ne ($line = [Console]::In.ReadLine())) {
      $requestedAction = $line.Trim().ToLowerInvariant()
      if ($requestedAction -notin @('get', 'mute', 'unmute', 'release')) { continue }
      try {
        if ($requestedAction -eq 'mute' -and -not $bridgeOwnsMute) {
          $bridgePriorMuted = [RadioWatch.CoreAudio]::GetMute()
          $bridgeOwnsMute = $true
        }
        if ($requestedAction -eq 'release') {
          if ($bridgeOwnsMute -and -not $bridgePriorMuted) { [void][RadioWatch.CoreAudio]::SetMute($false) }
          $muted = [RadioWatch.CoreAudio]::GetMute()
          $bridgeOwnsMute = $false
          $bridgePriorMuted = $false
        } else {
          $muted = Invoke-RadioWatchAudioAction $requestedAction
        }
        [Console]::Out.WriteLine((@{ ok = $true; muted = [bool]$muted; priorMuted = [bool]$bridgePriorMuted } | ConvertTo-Json -Compress))
      } catch {
        [Console]::Out.WriteLine((@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress))
      }
      [Console]::Out.Flush()
    }
  } finally {
    if ($bridgeOwnsMute -and -not $bridgePriorMuted) {
      try { [void][RadioWatch.CoreAudio]::SetMute($false) } catch { }
    }
    [RadioWatch.CoreAudio]::Close()
  }
  exit 0
}

$muted = Invoke-RadioWatchAudioAction $Action
[Console]::Out.WriteLine((@{ ok = $true; muted = [bool]$muted } | ConvertTo-Json -Compress))
