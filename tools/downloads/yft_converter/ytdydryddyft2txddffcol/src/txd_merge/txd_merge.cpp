#include <stdio.h>
#include "dffapi\Txd.h"
#include "dffapi\Memory.h"

gtaRwTextureNative *txd_find_texture(gtaRwTexDictionary *txd, char *name)
{
	for(gtaRwInt32 i = 0; i < txd->numTextures; i++)
	{
		if(!strcmp(txd->textures[i].name, name))
			return &txd->textures[i];
	}
	return NULL;
}

bool txd_has_texture(gtaRwTexDictionary *txd, char *name)
{
	for(gtaRwInt32 i = 0; i < txd->numTextures; i++)
	{
		if(!strcmp(txd->textures[i].name, name))
			return true;
	}
	return false;
}

bool merge_txd_with_txd(char *destpath, char *txdpath1, char *txdpath2)
{
	bool result = false;

	gtaRwStream *stream = gtaRwStreamOpen(rwSTREAMFILENAME, rwSTREAMREAD, txdpath1);
	if(stream)
	{
		gtaRwTexDictionary txd1;
		if(txd1.StreamRead(stream))
		{
			gtaRwStreamClose(stream);
			stream = gtaRwStreamOpen(rwSTREAMFILENAME, rwSTREAMREAD, txdpath2);
			if(stream)
			{
				gtaRwTexDictionary txd2;
				if(txd2.StreamRead(stream))
				{
					gtaRwStreamClose(stream);
					gtaRwTexDictionary txd;
					txd.Initialise(txd1.numTextures + txd2.numTextures);
					gtaMemCopy(txd.textures, txd1.textures, txd1.numTextures * sizeof(gtaRwTextureNative));
					unsigned int numUniqueTextureInTxd2 = 0;
					for(gtaRwInt32 i = 0; i < txd2.numTextures; i++)
					{
						if(!txd_has_texture(&txd1, txd2.textures[i].name))
						{
							gtaMemCopy(&txd.textures[txd1.numTextures + numUniqueTextureInTxd2], 
								&txd2.textures[i], sizeof(gtaRwTextureNative));
							numUniqueTextureInTxd2++;
						}
					}
					txd.numTextures = txd1.numTextures + numUniqueTextureInTxd2;
					stream = gtaRwStreamOpen(rwSTREAMFILENAME, rwSTREAMWRITE, destpath);
					if(stream)
					{
						txd.StreamWrite(stream);
						gtaRwStreamClose(stream);
						result = true;
					}
					txd1.Destroy();
					txd2.Destroy();
					gtaMemFree(txd.textures);
				}
				else
				{
					txd1.Destroy();
					gtaRwStreamClose(stream);
				}
			}
			else
			{
				txd1.Destroy();
				gtaRwStreamClose(stream);
			}
		}
		else
			gtaRwStreamClose(stream);
	}
	return result;
}

bool get_line(FILE *file, char *buf, unsigned int max_len, unsigned int *linesCounter)
{
	while(fgets(buf, max_len, file))
	{
		if(linesCounter)
			*linesCounter += 1;
		if(*buf != '#' && *buf != '\n' && *buf != '\r')
			return true;
	}
	return false;
}

int main()
{
	SetConsoleTitle("txd-merge");
	FILE *file = fopen("txd-merge.txt", "rt");
	if(file)
	{
		char line[MAX_PATH];
		unsigned int linesCounter;
		while(get_line(file, line, MAX_PATH, &linesCounter))
		{
			char txd_path1[MAX_PATH], txd_path2[MAX_PATH];
			if(sscanf(line, "%s %s", txd_path1, txd_path2) == 2)
			{
				if(!merge_txd_with_txd(txd_path1, txd_path1, txd_path2))
					printf("Error when merging \"%s\" with \"%s\"\n", txd_path1, txd_path2);
			}
			else
				printf("Error at line %d\n", linesCounter);
		}
		printf("Done.");
	}
	else
		printf("Can't open file \"txd-merge.txt\"\n");
	getchar();
	return 1;
}