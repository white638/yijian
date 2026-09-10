#ifndef AppVersion
  #define AppVersion "0.3.0"
#endif
#ifndef BuildRoot
  #define BuildRoot "..\.local\desktop-build"
#endif

[Setup]
AppId={{04D9FE4E-C937-4098-AF88-35D16F153859}
AppName=衣间
AppVersion={#AppVersion}
AppPublisher=Yijian contributors
AppPublisherURL=https://github.com/white638/yijian
AppSupportURL=https://github.com/white638/yijian/issues
AppUpdatesURL=https://github.com/white638/yijian/releases
DefaultDirName={localappdata}\Programs\Yijian
DefaultGroupName=衣间
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.19045
LicenseFile=..\LICENSE
OutputDir={#BuildRoot}\release
OutputBaseFilename=Yijian-{#AppVersion}-windows-x64-Setup
SetupIconFile={#BuildRoot}\resources\yijian.ico
UninstallDisplayIcon={app}\Yijian.exe
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
DisableProgramGroupPage=yes
UninstallDisplayName=衣间

[Languages]
Name: "chinesesimplified"; MessagesFile: "{#BuildRoot}\resources\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Messages]
chinesesimplified.BeveledLabel=衣间 · 用自己的衣服，搭配今天
chinesesimplified.FinishedLabel=衣间已安装完成。衣橱数据保存在你的 Windows 用户目录，升级和卸载应用都会保留数据。

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "快捷方式："

[Files]
Source: "{#BuildRoot}\dist\Yijian\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#BuildRoot}\tools\MicrosoftEdgeWebview2Setup.exe"; Flags: dontcopy

[Icons]
Name: "{group}\衣间"; Filename: "{app}\Yijian.exe"
Name: "{autodesktop}\衣间"; Filename: "{app}\Yijian.exe"; Tasks: desktopicon
Name: "{group}\衣间数据文件夹"; Filename: "{localappdata}\Yijian"

[Run]
Filename: "{app}\Yijian.exe"; Description: "打开衣间"; Flags: nowait postinstall skipifsilent

[Code]
function NeedsWebView2: Boolean;
var
  Version: String;
  Key: String;
begin
  Key := 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  Result := not ((RegQueryStringValue(HKLM32, Key, 'pv', Version) or
                 RegQueryStringValue(HKLM64, Key, 'pv', Version) or
                 RegQueryStringValue(HKCU, Key, 'pv', Version)) and (Version <> '') and (Version <> '0.0.0.0'));
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Result := '';
  if NeedsWebView2 then
  begin
    WizardForm.StatusLabel.Caption := '正在准备 Microsoft WebView2 窗口组件（需要网络）…';
    ExtractTemporaryFile('MicrosoftEdgeWebview2Setup.exe');
    if not Exec(ExpandConstant('{tmp}\MicrosoftEdgeWebview2Setup.exe'), '/silent /install', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
      Result := '无法启动 Microsoft WebView2 安装程序。请连接网络后重试。'
    else if ResultCode = 3010 then
    begin
      NeedsRestart := True;
      Result := 'Microsoft WebView2 已准备，请重启 Windows 后重新运行衣间安装程序。';
    end
    else if (ResultCode <> 0) or NeedsWebView2 then
      Result := 'Microsoft WebView2 尚未安装成功。请检查网络，或从 Microsoft 官网安装 WebView2 Runtime 后重新运行衣间安装程序。';
  end;
end;
