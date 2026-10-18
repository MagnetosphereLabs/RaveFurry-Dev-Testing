@echo off
setlocal EnableExtensions

REM ====================================================================
REM Raveberry Interactive Installer for Windows 11, runs on localhost.
REM Serves through anywt/newt to our server running Pangolin.
REM Run this from an activated Conda environment intended for Ravefurry.
REM ====================================================================

REM ---------- Defaults ----------
set "DEFAULT_CONDA_ENV=Raveberry"
set "DEFAULT_CONFIG_PATH=%USERPROFILE%\raveberry.yaml"
set "DEFAULT_INSTALL_DIR=C:\opt\raveberry\"
set "DEFAULT_HOSTNAME=127.0.0.1"
set "DEFAULT_PORT=8080"
set "DEFAULT_RAVEBERRY_REPO=https://github.com/Furatic/RaveFurry.git"
set "DEFAULT_RAVEBERRY_REF=main"

set "DEFAULT_YOUTUBE=true"
set "DEFAULT_SPOTIFY=false"
set "DEFAULT_SOUNDCLOUD=false"

REM Automatically disable raspberry pi features.
set "DEFAULT_SCREEN_VIS=false"
set "DEFAULT_LED_VIS=false"
set "DEFAULT_AUDIO_NORMALIZATION=false"
set "DEFAULT_HOTSPOT=false"
set "DEFAULT_BUZZER=false"

set "DEFAULT_POSTGRES_HOST=127.0.0.1"
set "DEFAULT_POSTGRES_PORT=54329"
set "DEFAULT_POSTGRES_DB=raveberry"
set "DEFAULT_POSTGRES_USER=raveberry"
set "DEFAULT_POSTGRES_PASSWORD=raveberry"

REM ---------- Main ----------
call :ensure_any_conda_environment
if errorlevel 1 exit /b 1

call :collect_answers
if errorlevel 1 exit /b 1

call :edit_loop
if errorlevel 1 exit /b 1

call :run_install
if errorlevel 1 exit /b 1

exit /b 0

REM ---------- Logging ----------
:log
echo(
echo ==> %~1
goto :eof

:warn
>&2 echo(
>&2 echo [WARN] %~1
goto :eof

:die
>&2 echo(
>&2 echo [ERROR] %~1
exit /b 1

REM ---------- Validators ----------
:is_abs_path
set "_check=%~1"
if not defined _check exit /b 1

if "%_check:~1,1%"==":" if "%_check:~2,1%"=="\" exit /b 0
if "%_check:~0,2%"=="\\" exit /b 0

exit /b 1

:is_valid_port
set "_port=%~1"
if not defined _port exit /b 1
echo(%_port%| findstr /R "^[0-9][0-9]*$" >nul || exit /b 1
2>nul set /a _portnum=%_port%
if errorlevel 1 exit /b 1
if %_portnum% lss 1 exit /b 1
if %_portnum% gtr 65535 exit /b 1
exit /b 0

:normalize_bool
set "RETVAL="
set "_nb=%~1"

if /I "%_nb%"=="y"     set "RETVAL=true"
if /I "%_nb%"=="yes"   set "RETVAL=true"
if /I "%_nb%"=="true"  set "RETVAL=true"
if /I "%_nb%"=="1"     set "RETVAL=true"
if /I "%_nb%"=="on"    set "RETVAL=true"

if /I "%_nb%"=="n"     set "RETVAL=false"
if /I "%_nb%"=="no"    set "RETVAL=false"
if /I "%_nb%"=="false" set "RETVAL=false"
if /I "%_nb%"=="0"     set "RETVAL=false"
if /I "%_nb%"=="off"   set "RETVAL=false"

if defined RETVAL exit /b 0
exit /b 1

REM ---------- Prompt helpers ----------
:ask_text
set "_at_var=%~1"
set "_at_prompt=%~2"
set "_at_default=%~3"
set "_at_validator=%~4"

:ask_text_loop
set "INPUT_VALUE="
set /p "INPUT_VALUE=%_at_prompt% [%_at_default%]: "
if not defined INPUT_VALUE set "INPUT_VALUE=%_at_default%"

if defined _at_validator (
    call :%_at_validator% "%INPUT_VALUE%"
    if errorlevel 1 (
        call :warn "Invalid value: %INPUT_VALUE%"
        goto :ask_text_loop
    )
)

set "%_at_var%=%INPUT_VALUE%"
goto :eof

:ask_bool
set "_ab_var=%~1"
set "_ab_prompt=%~2"
set "_ab_default=%~3"

:ask_bool_loop
set "INPUT_VALUE="
set /p "INPUT_VALUE=%_ab_prompt% [%_ab_default%]: "
if not defined INPUT_VALUE set "INPUT_VALUE=%_ab_default%"

call :normalize_bool "%INPUT_VALUE%"
if errorlevel 1 (
    call :warn "Please answer yes/no (y/n)."
    goto :ask_bool_loop
)

set "%_ab_var%=%RETVAL%"
goto :eof

:show_explainer
echo(
echo We will configure only relevant options:
echo(
echo - conda_environment:
echo   The Conda environment this installer expects to be active for Raveberry.
echo(
echo - install_directory:
echo   Where Raveberry app files are installed on disk.
echo(
echo - hostname:
echo   Hostname value used by installer/system config.
echo(
echo - port:
echo   Web server port ^(80 = normal HTTP^).
echo(
echo - youtube:
echo   Enables YouTube source support. Installer includes YouTube deps only when true.
echo(
echo - spotify:
echo   Enables Spotify source support. Installer adds Spotify deps only when true.
echo(
echo - soundcloud:
echo   Enables SoundCloud source support. Installer adds SoundCloud deps only when true.
echo(
echo Pi/hardware-centric options ^(LED/screen/buzzer/hotspot^) are auto-set to false in this script.
echo(
echo IMPORTANT:
echo This script must be run from an activated Conda environment intended for Raveberry.
echo It will verify that before installing.
echo(
goto :eof

REM ---------- Conda checks ----------
:ensure_any_conda_environment
if not defined CONDA_DEFAULT_ENV (
    call :die "No active Conda environment detected. Open the target environment's CMD terminal, activate it, and rerun this script."
    exit /b 1
)

if not defined CONDA_PREFIX (
    call :die "CONDA_PREFIX is missing. Open the target environment's CMD terminal, activate it, and rerun this script."
    exit /b 1
)

exit /b 0

:ensure_expected_conda_environment
call :log "[1/6] Checking active Conda environment"
call :ensure_any_conda_environment
if errorlevel 1 exit /b 1

echo Current active Conda environment = %CONDA_DEFAULT_ENV%
echo Current CONDA_PREFIX            = %CONDA_PREFIX%

if /I "%CONDA_DEFAULT_ENV%"=="base" (
    call :die "The active Conda environment is 'base'. Use a dedicated env for Raveberry, then rerun."
    exit /b 1
)

if /I not "%CONDA_DEFAULT_ENV%"=="%EXPECTED_CONDA_ENV%" (
    call :die "Active Conda environment '%CONDA_DEFAULT_ENV%' does not match expected environment '%EXPECTED_CONDA_ENV%'. Activate the intended env and rerun."
    exit /b 1
)

exit /b 0

REM ---------- Collect config ----------
:collect_answers
call :show_explainer

call :ask_text EXPECTED_CONDA_ENV "Expected active Conda environment name for Raveberry" "%DEFAULT_CONDA_ENV%"
call :ask_text CONFIG_PATH "Path to write raveberry.yaml" "%DEFAULT_CONFIG_PATH%"
call :ask_text INSTALL_DIR "Raveberry install_directory" "%DEFAULT_INSTALL_DIR%" is_abs_path
call :ask_text HOSTNAME_VALUE "Bind address for Raveberry (127.0.0.1 = local-only)" "%DEFAULT_HOSTNAME%"
call :ask_text PORT_VALUE "Web port" "%DEFAULT_PORT%" is_valid_port

call :ask_bool YOUTUBE "Enable YouTube support?" "%DEFAULT_YOUTUBE%"
call :ask_bool SPOTIFY "Enable Spotify support? (requires Spotify account setup later)" "%DEFAULT_SPOTIFY%"
call :ask_bool SOUNDCLOUD "Enable SoundCloud support?" "%DEFAULT_SOUNDCLOUD%"

set "SCREEN_VIS=%DEFAULT_SCREEN_VIS%"
set "LED_VIS=%DEFAULT_LED_VIS%"
set "AUDIO_NORMALIZATION=%DEFAULT_AUDIO_NORMALIZATION%"
set "HOTSPOT=%DEFAULT_HOTSPOT%"
set "BUZZER=%DEFAULT_BUZZER%"

goto :eof

:print_summary
echo(
echo ==================== REVIEW ====================
echo 1^) EXPECTED_CONDA_ENV     = %EXPECTED_CONDA_ENV%
echo 2^) CURRENT_CONDA_ENV      = %CONDA_DEFAULT_ENV%
echo 3^) CONFIG_PATH            = %CONFIG_PATH%
echo 4^) INSTALL_DIR            = %INSTALL_DIR%
echo 5^) HOSTNAME               = %HOSTNAME_VALUE%
echo 6^) PORT                   = %PORT_VALUE%
echo 7^) YOUTUBE                = %YOUTUBE%
echo 8^) SPOTIFY                = %SPOTIFY%
echo 9^) SOUNDCLOUD             = %SOUNDCLOUD%
echo(
echo Automatically disabled:
echo - screen_visualization    = %SCREEN_VIS%
echo - led_visualization       = %LED_VIS%
echo - audio_normalization     = %AUDIO_NORMALIZATION%
echo - hotspot                 = %HOTSPOT%
echo - buzzer                  = %BUZZER%
echo ================================================
echo(
goto :eof

:edit_loop
:edit_loop_top
call :print_summary
echo Choose: [C]ontinue, [E]dit a field, [Q]uit
set "ACTION="
set /p "ACTION=> "
if not defined ACTION set "ACTION=C"

if /I "%ACTION%"=="C" exit /b 0
if /I "%ACTION%"=="CONTINUE" exit /b 0

if /I "%ACTION%"=="Q" (
    call :die "User aborted."
    exit /b 1
)
if /I "%ACTION%"=="QUIT" (
    call :die "User aborted."
    exit /b 1
)

if /I not "%ACTION%"=="E" if /I not "%ACTION%"=="EDIT" (
    call :warn "Unknown option."
    goto :edit_loop_top
)

set "FIELDNUM="
set /p "FIELDNUM=Enter field number to edit (1-9): "

if "%FIELDNUM%"=="1" goto :edit_field_1
if "%FIELDNUM%"=="2" goto :edit_field_2
if "%FIELDNUM%"=="3" goto :edit_field_3
if "%FIELDNUM%"=="4" goto :edit_field_4
if "%FIELDNUM%"=="5" goto :edit_field_5
if "%FIELDNUM%"=="6" goto :edit_field_6
if "%FIELDNUM%"=="7" goto :edit_field_7
if "%FIELDNUM%"=="8" goto :edit_field_8
if "%FIELDNUM%"=="9" goto :edit_field_9

call :warn "Invalid field number."
goto :edit_loop_top

:edit_field_1
call :ask_text EXPECTED_CONDA_ENV "Expected active Conda environment name for Raveberry" "%EXPECTED_CONDA_ENV%"
goto :edit_loop_top

:edit_field_2
call :warn "CURRENT_CONDA_ENV is read-only. Activate a different Conda env outside this script, then rerun."
goto :edit_loop_top

:edit_field_3
call :ask_text CONFIG_PATH "Path to write raveberry.yaml" "%CONFIG_PATH%"
goto :edit_loop_top

:edit_field_4
call :ask_text INSTALL_DIR "Raveberry install_directory" "%INSTALL_DIR%" is_abs_path
goto :edit_loop_top

:edit_field_5
call :ask_text HOSTNAME_VALUE "Hostname for Raveberry" "%HOSTNAME_VALUE%"
goto :edit_loop_top

:edit_field_6
call :ask_text PORT_VALUE "Web port" "%PORT_VALUE%" is_valid_port
goto :edit_loop_top

:edit_field_7
call :ask_bool YOUTUBE "Enable YouTube support?" "%YOUTUBE%"
goto :edit_loop_top

:edit_field_8
call :ask_bool SPOTIFY "Enable Spotify support?" "%SPOTIFY%"
goto :edit_loop_top

:edit_field_9
call :ask_bool SOUNDCLOUD "Enable SoundCloud support?" "%SOUNDCLOUD%"
goto :edit_loop_top

REM ---------- Install helpers ----------
:ensure_git
where git >nul 2>&1
if not errorlevel 1 (
    echo Found git in PATH.
    exit /b 0
)

call :warn "git was not found in the active environment or PATH."
where conda >nul 2>&1
if errorlevel 1 (
    call :die "conda command not found in this shell. Open the Conda CMD terminal for the env and rerun."
    exit /b 1
)

call :log "Installing git into the active Conda environment"
call conda install -y git
if errorlevel 1 (
    call :die "Failed to install git with conda."
    exit /b 1
)

where git >nul 2>&1
if errorlevel 1 (
    call :die "git still was not found after Conda install."
    exit /b 1
)

echo Found git in PATH.
exit /b 0

:ensure_ffmpeg
set "ENV_FFMPEG=%CONDA_PREFIX%\Library\bin\ffmpeg.exe"

if exist "%ENV_FFMPEG%" (
    set "PATH=%CONDA_PREFIX%\Library\bin;%PATH%"
    "%ENV_FFMPEG%" -version >nul 2>&1
    if errorlevel 1 (
        call :die "ffmpeg.exe exists in the active Conda environment, but it failed to execute."
        exit /b 1
    )
    echo Found ffmpeg in the active Conda environment.
    exit /b 0
)

call :warn "ffmpeg was not found in the active Conda environment."

where conda >nul 2>&1
if errorlevel 1 (
    call :die "conda command not found in this shell. Open the Conda CMD terminal for the env and rerun."
    exit /b 1
)

call :log "Previewing safe FFmpeg install into the active Conda environment"
echo DO NOT press Ctrl+C during Conda transactions.
call conda install -p "%CONDA_PREFIX%" -c conda-forge --strict-channel-priority --freeze-installed ffmpeg --dry-run
if errorlevel 1 (
    call :die "Safe FFmpeg dry-run failed. Refusing to modify the active Conda environment automatically."
    exit /b 1
)

call :log "Installing ffmpeg into the active Conda environment"
echo DO NOT press Ctrl+C during Conda transactions.
call conda install -p "%CONDA_PREFIX%" -c conda-forge --strict-channel-priority --freeze-installed ffmpeg -y
if errorlevel 1 (
    call :die "Failed to install ffmpeg with conda."
    exit /b 1
)

set "PATH=%CONDA_PREFIX%\Library\bin;%PATH%"

if not exist "%ENV_FFMPEG%" (
    call :die "ffmpeg.exe was not found at %ENV_FFMPEG% after Conda install."
    exit /b 1
)

"%ENV_FFMPEG%" -version >nul 2>&1
if errorlevel 1 (
    call :die "ffmpeg was installed but failed to execute."
    exit /b 1
)

where ffmpeg >nul 2>&1
if errorlevel 1 (
    call :die "ffmpeg still was not found in PATH after Conda install."
    exit /b 1
)

echo Found ffmpeg in PATH.
exit /b 0

:write_config_file
call :log "[5/6] Writing config to %CONFIG_PATH%"

for %%I in ("%CONFIG_PATH%") do set "CONFIG_DIR=%%~dpI"
if not exist "%CONFIG_DIR%" mkdir "%CONFIG_DIR%"
if errorlevel 1 (
    call :die "Failed to create config directory '%CONFIG_DIR%'."
    exit /b 1
)

if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
if errorlevel 1 (
    call :die "Failed to create install directory '%INSTALL_DIR%'."
    exit /b 1
)

> "%CONFIG_PATH%" (
    echo install_directory: %INSTALL_DIR%
    echo hostname: %HOSTNAME_VALUE%
    echo port: %PORT_VALUE%
    echo(
    echo youtube: %YOUTUBE%
    echo spotify: %SPOTIFY%
    echo soundcloud: %SOUNDCLOUD%
    echo(
    echo screen_visualization: %SCREEN_VIS%
    echo led_visualization: %LED_VIS%
    echo audio_normalization: %AUDIO_NORMALIZATION%
    echo hotspot: %HOTSPOT%
    echo buzzer: %BUZZER%
    echo(
    echo cache_dir:
    echo cache_medium:
    echo(
    echo hotspot_ssid: Raveberry
    echo hotspot_password:
    echo homewifi:
    echo(
    echo remote_key:
    echo remote_bind_address:
    echo remote_ip:
    echo remote_port:
    echo remote_url:
    echo(
    echo db_backup:
    echo backup_command:
)

if errorlevel 1 (
    call :die "Failed to write config file '%CONFIG_PATH%'."
    exit /b 1
)

dir "%CONFIG_PATH%"
exit /b 0

REM ---------- Install steps ----------
:run_install
call :ensure_expected_conda_environment
if errorlevel 1 exit /b 1
call :ensure_ffmpeg
if errorlevel 1 exit /b 1

set "DJANGO_USE_SQLITE=0"
set "POSTGRES_HOST=%DEFAULT_POSTGRES_HOST%"
set "POSTGRES_PORT=%DEFAULT_POSTGRES_PORT%"
set "POSTGRES_DB=%DEFAULT_POSTGRES_DB%"
set "POSTGRES_USER=%DEFAULT_POSTGRES_USER%"
set "POSTGRES_PASSWORD=%DEFAULT_POSTGRES_PASSWORD%"
set "PGPASSWORD=%POSTGRES_PASSWORD%"

if not defined LOCALAPPDATA set "LOCALAPPDATA=%USERPROFILE%\AppData\Local"
set "RAVEBERRY_PGROOT=%LOCALAPPDATA%\Raveberry\postgres"
set "RAVEBERRY_PGDATA=%RAVEBERRY_PGROOT%\data"
set "RAVEBERRY_PGLOG=%RAVEBERRY_PGROOT%\postgres.log"

set "PATH=%CONDA_PREFIX%\Library\bin;%PATH%"

call :log "[2/8] Installing prerequisites"
call :ensure_git
if errorlevel 1 exit /b 1

if exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" (
    set "PATH=%SystemRoot%\System32;%SystemRoot%\System32\WindowsPowerShell\v1.0;%PATH%"
)

where powershell >nul 2>&1
if errorlevel 1 (
    call :die "powershell.exe is not available in PATH. Windows PowerShell is required for the Conda Node.js install step."
    exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
    call :log "Installing Node.js 24 LTS into the active Conda environment"
    call conda install -y -c conda-forge "nodejs>=24,<25"
    if errorlevel 1 (
        call :die "Failed to install Node.js 24 LTS with conda."
        exit /b 1
    )
)

where node >nul 2>&1
if errorlevel 1 (
    call :die "node was not found after Conda install."
    exit /b 1
)

for /f "delims=" %%I in ('node -v') do set "NODE_VERSION=%%I"
echo Detected Node.js version: %NODE_VERSION%

echo %NODE_VERSION% | findstr /R "^v25\." >nul
if not errorlevel 1 (
    call :die "Detected Node.js 25, which is currently causing Yarn EBADF build failures. Remove it from this Conda env and rerun so Node 24 LTS can be installed."
    exit /b 1
)

where yarn >nul 2>&1
if errorlevel 1 (
    call :log "Installing Yarn into the active Conda environment"
    call conda install -y -c conda-forge yarn
    if errorlevel 1 (
        call :log "Conda Yarn install failed, trying npm global install inside the active environment"
        call npm install -g yarn
        if errorlevel 1 (
            call :die "Failed to install yarn with both conda and npm."
            exit /b 1
        )
    )
)

where yarn >nul 2>&1
if errorlevel 1 (
    call :die "yarn was not found after install."
    exit /b 1
)

call :log "[3/8] Using active Conda environment"
python --version
if errorlevel 1 (
    call :die "python command failed in the active Conda environment."
    exit /b 1
)

python -m pip --version
if errorlevel 1 (
    call :die "pip is not available in the active Conda environment."
    exit /b 1
)

call :log "[4/6] Installing raveberry CLI from your GitHub repo"
python -m pip install --upgrade pip setuptools wheel
if errorlevel 1 (
    call :die "Failed to upgrade pip/setuptools/wheel."
    exit /b 1
)

python -m pip install --force-reinstall "raveberry[run] @ git+%DEFAULT_RAVEBERRY_REPO%@%DEFAULT_RAVEBERRY_REF%"
if errorlevel 1 (
    call :die "Failed to install raveberry from the GitHub repository."
    exit /b 1
)

set "RAVEBERRY_SCRIPT=%CONDA_PREFIX%\Scripts\raveberry"

if not exist "%RAVEBERRY_SCRIPT%" (
    call :die "Installed raveberry script was not found at %RAVEBERRY_SCRIPT%"
    exit /b 1
)

python "%RAVEBERRY_SCRIPT%" --help >nul 2>&1
if errorlevel 1 (
    call :die "raveberry script exists but failed to run through python."
    exit /b 1
)

python -c "import importlib.metadata as m; print('Installed raveberry version:', m.version('raveberry'))"
if errorlevel 1 (
    call :die "Unable to read installed raveberry package metadata."
    exit /b 1
)

set "RAVEBERRY_SOURCE_DIR=%INSTALL_DIR%source"

if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
if errorlevel 1 (
    call :die "Failed to create install directory '%INSTALL_DIR%'."
    exit /b 1
)

call :log "[5/8] Preparing local frontend source tree at %RAVEBERRY_SOURCE_DIR%"
if not exist "%RAVEBERRY_SOURCE_DIR%" (
    git clone --branch "%DEFAULT_RAVEBERRY_REF%" "%DEFAULT_RAVEBERRY_REPO%" "%RAVEBERRY_SOURCE_DIR%"
    if errorlevel 1 (
        call :die "Failed to clone Raveberry source into %RAVEBERRY_SOURCE_DIR%"
        exit /b 1
    )
) else (
    if not exist "%RAVEBERRY_SOURCE_DIR%\.git" (
        call :die "Source directory exists but is not a git repository: %RAVEBERRY_SOURCE_DIR%"
        exit /b 1
    )
    REM Keep existing source checkouts pointed at the selected repository.
    git -C "%RAVEBERRY_SOURCE_DIR%" remote set-url origin "%DEFAULT_RAVEBERRY_REPO%"
    if errorlevel 1 (
        call :die "Failed to update the source repository URL."
        exit /b 1
    )
    git -C "%RAVEBERRY_SOURCE_DIR%" fetch origin
    if errorlevel 1 (
        call :die "Failed to fetch latest source updates."
        exit /b 1
    )
    git -C "%RAVEBERRY_SOURCE_DIR%" checkout "%DEFAULT_RAVEBERRY_REF%"
    if errorlevel 1 (
        call :die "Failed to checkout source ref %DEFAULT_RAVEBERRY_REF%."
        exit /b 1
    )
    git -C "%RAVEBERRY_SOURCE_DIR%" reset --hard "origin/%DEFAULT_RAVEBERRY_REF%"
    if errorlevel 1 (
        call :die "Failed to reset source tree to origin/%DEFAULT_RAVEBERRY_REF%."
        exit /b 1
    )
)

call :log "[6/8] Writing frontend Yarn config"
> "%RAVEBERRY_SOURCE_DIR%\frontend\.yarnrc.yml" echo nodeLinker: node-modules
if errorlevel 1 (
    call :die "Failed to write frontend\.yarnrc.yml"
    exit /b 1
)

call :log "[7/8] Building frontend assets"
call yarn --cwd "%RAVEBERRY_SOURCE_DIR%\frontend" install
if errorlevel 1 (
    call :die "Frontend yarn install failed."
    exit /b 1
)

call yarn --cwd "%RAVEBERRY_SOURCE_DIR%\frontend" build
if errorlevel 1 (
    call :die "Frontend yarn build failed."
    exit /b 1
)

for /f "delims=" %%I in ('python -c "import os, raveberry; print(os.path.dirname(raveberry.__file__))"') do set "RBPKG=%%I"
if not defined RBPKG (
    call :die "Could not determine installed Raveberry package path."
    exit /b 1
)

if not exist "%RBPKG%\static" mkdir "%RBPKG%\static"
if errorlevel 1 (
    call :die "Failed to create installed static directory at %RBPKG%\static"
    exit /b 1
)

xcopy /E /I /Y "%RAVEBERRY_SOURCE_DIR%\backend\static\*" "%RBPKG%\static\" >nul
if errorlevel 1 (
    call :die "Failed to copy built frontend assets into installed Raveberry package."
    exit /b 1
)

call :write_config_file
if errorlevel 1 exit /b 1

call :ensure_local_postgres
if errorlevel 1 exit /b 1
call :log "[8/8] Starting local Raveberry server"
python "%RAVEBERRY_SCRIPT%" run --nomopidy
if errorlevel 1 (
    call :die "raveberry run failed."
    exit /b 1
)

exit /b 0

:ensure_local_postgres
call :log "[9/9] Ensuring local PostgreSQL"

where initdb >nul 2>&1
if errorlevel 1 (
    call :log "Installing PostgreSQL server/client into the active Conda environment"
    call conda install -y -c conda-forge postgresql psycopg2
    if errorlevel 1 (
        call :die "Failed to install PostgreSQL server/client into the active Conda environment."
        exit /b 1
    )
    set "PATH=%CONDA_PREFIX%\Library\bin;%PATH%"
)

python -c "import psycopg2" >nul 2>&1
if errorlevel 1 (
    call :log "Installing psycopg2 into the active Conda environment"
    call conda install -y -c conda-forge psycopg2
    if errorlevel 1 (
        call :die "Failed to install psycopg2 into the active Conda environment."
        exit /b 1
    )
)

if not exist "%RAVEBERRY_PGROOT%" mkdir "%RAVEBERRY_PGROOT%"
if errorlevel 1 (
    call :die "Failed to create PostgreSQL root directory '%RAVEBERRY_PGROOT%'."
    exit /b 1
)

if not exist "%RAVEBERRY_PGDATA%\PG_VERSION" (
    call :log "Initializing local PostgreSQL data directory"
    initdb -D "%RAVEBERRY_PGDATA%" -U postgres -A trust --encoding=UTF8
    if errorlevel 1 (
        call :die "Failed to initialize PostgreSQL data directory."
        exit /b 1
    )

    >> "%RAVEBERRY_PGDATA%\postgresql.conf" echo listen_addresses = '127.0.0.1'
    >> "%RAVEBERRY_PGDATA%\postgresql.conf" echo port = %POSTGRES_PORT%
)

pg_isready -h %POSTGRES_HOST% -p %POSTGRES_PORT% -d postgres >nul 2>&1
if errorlevel 1 (
    call :log "Starting local PostgreSQL"
    pg_ctl -D "%RAVEBERRY_PGDATA%" -l "%RAVEBERRY_PGLOG%" -o "-p %POSTGRES_PORT%" -w start
    if errorlevel 1 (
        call :die "Failed to start local PostgreSQL."
        exit /b 1
    )
)

timeout /t 2 /nobreak >nul

pg_isready -h %POSTGRES_HOST% -p %POSTGRES_PORT% -d postgres >nul 2>&1
if errorlevel 1 (
    call :die "Local PostgreSQL is still not accepting connections after startup."
    exit /b 1
)

psql -h %POSTGRES_HOST% -p %POSTGRES_PORT% -U postgres -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='%POSTGRES_USER%'" 2>nul | findstr /R "^[ ]*1[ ]*$" >nul
if errorlevel 1 (
    call :log "Creating PostgreSQL role %POSTGRES_USER%"
    psql -h %POSTGRES_HOST% -p %POSTGRES_PORT% -U postgres -d postgres -c "CREATE ROLE %POSTGRES_USER% LOGIN PASSWORD '%POSTGRES_PASSWORD%';"
    if errorlevel 1 (
        call :die "Failed to create PostgreSQL role '%POSTGRES_USER%'."
        exit /b 1
    )
)

set "RB_DB_EXISTS="
for /f "usebackq delims=" %%I in (`psql -h %POSTGRES_HOST% -p %POSTGRES_PORT% -U postgres -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='%POSTGRES_DB%'" 2^>nul`) do set "RB_DB_EXISTS=%%I"
set "RB_DB_EXISTS=%RB_DB_EXISTS: =%"

if not "%RB_DB_EXISTS%"=="1" (
    echo.
    echo [INFO] Creating PostgreSQL database %POSTGRES_DB% with UTF8 encoding...
    createdb -h %POSTGRES_HOST% -p %POSTGRES_PORT% -U postgres -O %POSTGRES_USER% -E UTF8 -T template0 %POSTGRES_DB%
    if errorlevel 1 exit /b 1
) else (
    set "RB_DB_ENCODING="
    for /f "usebackq delims=" %%I in (`psql -h %POSTGRES_HOST% -p %POSTGRES_PORT% -U postgres -d postgres -tAc "SELECT pg_encoding_to_char(encoding) FROM pg_database WHERE datname='%POSTGRES_DB%'" 2^>nul`) do set "RB_DB_ENCODING=%%I"
    set "RB_DB_ENCODING=%RB_DB_ENCODING: =%"

    if /I not "%RB_DB_ENCODING%"=="UTF8" (
        echo.
        echo [INFO] Recreating PostgreSQL database %POSTGRES_DB% with UTF8 encoding...
        psql -h %POSTGRES_HOST% -p %POSTGRES_PORT% -U postgres -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='%POSTGRES_DB%' AND pid <> pg_backend_pid();" >nul 2>&1
        dropdb -h %POSTGRES_HOST% -p %POSTGRES_PORT% -U postgres --if-exists %POSTGRES_DB%
        if errorlevel 1 exit /b 1
        createdb -h %POSTGRES_HOST% -p %POSTGRES_PORT% -U postgres -O %POSTGRES_USER% -E UTF8 -T template0 %POSTGRES_DB%
        if errorlevel 1 exit /b 1
    )
)

exit /b 0

call :log "Done. Open via hostname/IP on port %PORT_VALUE%."
exit /b 0
