#pragma once

#include <Windows.h>
#include <stdio.h>
#include "Hash.h"

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
	SetConsoleTitle("hash");
	FILE *file = fopen("names.txt", "rt");
	if(file)
	{
		char line[MAX_PATH];
		unsigned int linesCounter;
		FILE *hashesFile = fopen("hashes.txt", "wt");
		while(get_line(file, line, MAX_PATH, &linesCounter))
		{
			char name[MAX_PATH];
			if(sscanf(line, "%s", name) == 1)
			{
				fprintf(hashesFile, "%X %s\n", HASH(name), name);
			}
			else
			{
				fputs("# ERROR\n", hashesFile);
				printf("Error at line %d\n", linesCounter);
			}
		}
		fclose(hashesFile);
		printf("Done.");
	}
	else
		printf("Can't open file \"names.txt\"\n");
	getchar();
	return 1;
}