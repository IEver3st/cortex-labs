#pragma once

#include <Windows.h>
#include <stdio.h>
#include "Search.h"

FILE *gColFile;

void write_col_file(char *filename)
{
	FILE *file = fopen(filename, "rb");
	if(file)
	{
		fseek(file, 0, SEEK_END);
		unsigned int filesize = ftell(file);
		unsigned char *data = new unsigned char[filesize];
		fseek(file, 0, SEEK_SET);
		fread(data, filesize, 1, file);
		fclose(file);
		fwrite(data, filesize, 1, gColFile);
		delete[] data;
	}
	else
		printf("Error when opening file \"%s\"\n", filename);
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
	SetConsoleTitle("col-merge");
	FILE *file = fopen("col-merge.txt", "rt");
	if(file)
	{
		char line[MAX_PATH];
		unsigned int linesCounter;
		while(get_line(file, line, MAX_PATH, &linesCounter))
		{
			char colfile_path[MAX_PATH], folder_path[MAX_PATH];
			if(sscanf(line, "%s %s", colfile_path, folder_path) == 2)
			{
				gColFile = fopen(colfile_path, "wb");
				if(gColFile)
				{
					char search_path[MAX_PATH];
					strcpy(search_path, folder_path);
					strcat(search_path, "\\*.col");
					SearchFiles(search_path, (LPSEARCHFUNC)write_col_file, FALSE);
					fclose(gColFile);
				}
				else
					printf("Error when creating file \"%s\"\n", colfile_path);
			}
			else
				printf("Error at line %d\n", linesCounter);
		}
		printf("Done.");
	}
	else
		printf("Can't open file \"col-merge.txt\"\n");
	getchar();
	return 1;
}