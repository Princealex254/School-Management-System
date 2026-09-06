$root = 'C:\Users\Alex Senerwa\Desktop\Shule Smart'
$tpl = Get-Content -Raw "$root\_template.html"
function G([string]$file,[hashtable]$cfg){
  $json = ConvertTo-Json -InputObject $cfg -Depth 6 -Compress
  $o = $tpl.Replace('__CFG__',$json).Replace('__TITLE__',$cfg.title).Replace('__HEADING__',$cfg.heading).Replace('__DESC__',$cfg.desc).Replace('__ADDLABEL__',$cfg.addLabel)
  $destDir = Join-Path $root $file
  if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
  [System.IO.File]::WriteAllText("$destDir\index.html",$o,[System.Text.Encoding]::UTF8)
  Write-Host "wrote $file/index.html"
}
