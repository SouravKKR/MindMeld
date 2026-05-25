@echo off
if not exist "Common\node_modules" (
    echo Installing build dependencies in Common/...
    pushd Common
    call npm install
    popd
)

node ./Common/Scripts/GenerateServiceManifest.js
node ./Common/Scripts/GenerateEnumerations.js
node ./Common/Scripts/GenerateConstants.js
node ./Common/Scripts/GenerateClasses.js
node ./Common/Scripts/CopyStaticFiles.js

if /I "%~1"=="--conservative" (
    node ./Common/Scripts/BundleStaticFiles.js
    node ./Common/Scripts/ManglePrivateMembersInBundle.js
    node ./Common/Scripts/MinifyAndObfuscateStaticFiles.js
) else if /I "%~1"=="--aggressive" (
    node ./Common/Scripts/BundleStaticFiles.js
    node ./Common/Scripts/ManglePrivateMembersInBundle.js
    node ./Common/Scripts/MinifyAndObfuscateStaticFiles.js --aggressive
) else (
    echo Skipping bundling, minification and obfuscation.
)
