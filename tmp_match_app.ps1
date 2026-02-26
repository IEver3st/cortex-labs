Select-String -Path src\App.jsx -Pattern marker,detection,detectedIsland,island,islandColor,islandVisibility | ForEach-Object { Write-Output ($_.LineNumber.ToString() + ':' + $_.Line.Trim()) } 
