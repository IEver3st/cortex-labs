$start=150;$end=240;Get-Content src\components\VariantsPage.jsx | Select-Object -Skip ($start-1) -First ($end-$start+1) | % { $script:i++; ('{0}: {1}' -f ($start+$i-1), $_) }  
