#ifndef UNICODE
#define UNICODE
#endif
#include <windows.h>
#include <ncrypt.h>
#include <bcrypt.h>
#include <stdio.h>
#include <string.h>
static int fail(const char *step, SECURITY_STATUS code) { fprintf(stderr,"%s failed (0x%08lx)\n",step,(unsigned long)code); return 1; }
static void hex(const BYTE *data, DWORD size) { for(DWORD i=0;i<size;i++) printf("%02x",data[i]); putchar('\n'); }
int main(int argc, char **argv) {
  if(argc!=2 || (strcmp(argv[1],"public") && strcmp(argv[1],"sign"))) return 2;
  NCRYPT_PROV_HANDLE provider=0; NCRYPT_KEY_HANDLE key=0; DWORD size=0,impl=0;
  SECURITY_STATUS rc=NCryptOpenStorageProvider(&provider,MS_PLATFORM_CRYPTO_PROVIDER,0);
  if(rc)return fail("Open TPM provider",rc);
  rc=NCryptGetProperty(provider,NCRYPT_IMPL_TYPE_PROPERTY,(PBYTE)&impl,sizeof(impl),&size,0);
  if(rc || !(impl & NCRYPT_IMPL_HARDWARE_FLAG)) { NCryptFreeObject(provider); return fail("Require hardware provider",rc); }
  rc=NCryptOpenKey(provider,&key,L"Serenetia.TiaLauncher.DeveloperDevice.v1",0,0);
  if(rc==NTE_BAD_KEYSET || rc==NTE_NOT_FOUND) {
    rc=NCryptCreatePersistedKey(provider,&key,NCRYPT_ECDSA_P256_ALGORITHM,L"Serenetia.TiaLauncher.DeveloperDevice.v1",0,0);
    DWORD exportPolicy=0,usage=NCRYPT_ALLOW_SIGNING_FLAG;
    if(!rc)rc=NCryptSetProperty(key,NCRYPT_EXPORT_POLICY_PROPERTY,(PBYTE)&exportPolicy,sizeof(exportPolicy),0);
    if(!rc)rc=NCryptSetProperty(key,NCRYPT_KEY_USAGE_PROPERTY,(PBYTE)&usage,sizeof(usage),0);
    if(!rc)rc=NCryptFinalizeKey(key,0);
  }
  if(rc){NCryptFreeObject(provider);return fail("Open TPM signing key",rc);}
  BYTE publicBlob[sizeof(BCRYPT_ECCKEY_BLOB)+64];
  rc=NCryptExportKey(key,0,BCRYPT_ECCPUBLIC_BLOB,NULL,publicBlob,sizeof(publicBlob),&size,0);
  BCRYPT_ECCKEY_BLOB *header=(BCRYPT_ECCKEY_BLOB *)publicBlob;
  if(rc || size!=sizeof(publicBlob) || header->dwMagic!=BCRYPT_ECDSA_PUBLIC_P256_MAGIC || header->cbKey!=32){NCryptFreeObject(key);NCryptFreeObject(provider);return fail("Export hardware public key",rc);}
  if(!strcmp(argv[1],"public")){BYTE point[65];point[0]=4;memcpy(point+1,publicBlob+sizeof(*header),64);hex(point,65);}
  else {
    BYTE message[1025];size_t length=fread(message,1,sizeof(message),stdin);
    if(length<20 || length>1024 || memcmp(message,"tia-launcher-dev/v1\n",20)){NCryptFreeObject(key);NCryptFreeObject(provider);return 2;}
    BCRYPT_ALG_HANDLE algorithm=0;BCRYPT_HASH_HANDLE hash=0;BYTE digest[32];
    NTSTATUS status=BCryptOpenAlgorithmProvider(&algorithm,BCRYPT_SHA256_ALGORITHM,NULL,0);
    if(!status)status=BCryptCreateHash(algorithm,&hash,NULL,0,NULL,0,0);
    if(!status)status=BCryptHashData(hash,message,(ULONG)length,0);
    if(!status)status=BCryptFinishHash(hash,digest,sizeof(digest),0);
    if(hash)BCryptDestroyHash(hash);if(algorithm)BCryptCloseAlgorithmProvider(algorithm,0);
    BYTE signature[128];
    if(status)rc=(SECURITY_STATUS)status;
    else rc=NCryptSignHash(key,NULL,digest,sizeof(digest),signature,sizeof(signature),&size,0);
    if(rc || size!=64){NCryptFreeObject(key);NCryptFreeObject(provider);return fail("TPM signature",rc);}
    hex(signature,size);
  }
  NCryptFreeObject(key);NCryptFreeObject(provider);return 0;
}
