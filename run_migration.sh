#!/bin/bash
set -e

echo "Starting migration of zeljka_markic_i_narod_hr..."
time rsync -a /Volumes/DOMOVINA1TB/fetch_domovina_tv_output/zeljka_markic_i_narod_hr/ /Volumes/DOMOVINA2TB/fetch_domovina_tv_output/zeljka_markic_i_narod_hr/
rm storage/output/zeljka_markic_i_narod_hr
ln -s /Volumes/DOMOVINA2TB/fetch_domovina_tv_output/zeljka_markic_i_narod_hr storage/output/zeljka_markic_i_narod_hr
rm -rf /Volumes/DOMOVINA1TB/fetch_domovina_tv_output/zeljka_markic_i_narod_hr
echo "Completed zeljka_markic_i_narod_hr"

echo "Starting migration of podcast_cuspajz..."
time rsync -a /Volumes/DOMOVINA1TB/fetch_domovina_tv_output/podcast_cuspajz/ /Volumes/DOMOVINA2TB/fetch_domovina_tv_output/podcast_cuspajz/
rm storage/output/podcast_cuspajz
ln -s /Volumes/DOMOVINA2TB/fetch_domovina_tv_output/podcast_cuspajz storage/output/podcast_cuspajz
rm -rf /Volumes/DOMOVINA1TB/fetch_domovina_tv_output/podcast_cuspajz
echo "Completed podcast_cuspajz"
