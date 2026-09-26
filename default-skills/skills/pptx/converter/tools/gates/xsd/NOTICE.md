# ECMA-376 transitional XML schemas (vendored, unmodified)

These 26 `.xsd` files are the **Office Open XML transitional schemas** of **ECMA-376, 5th edition (2016),
Part 4 "Transitional Migration Features"** — byte-identical to the members of `OfficeOpenXML-XMLSchema-Transitional.zip`
inside https://ecma-international.org/wp-content/uploads/ECMA-376-4_5th_edition_december_2016.zip
(publication page: https://ecma-international.org/publications-and-standards/standards/ecma-376/).

Copyright remains with Ecma International, which publishes ECMA-376 free of charge. The files are shipped
unmodified, as reference data for the converter's own build gates; nothing here is part of Noah's own code.

Used by:

- `../chart_verify.py` (`chart-verify` gate): every chart part is validated against `dml-chart.xsd`;
- `../indep_check.py` (`indep-check` gate): `presentation.xml` against `pml.xsd`, and the `CT_Presentation`
  child order is read from `pml.xsd` itself.

The PoC kept two copies of this set (its chart lane and its font-embedding review lane); they were compared file by
file, are identical to each other and to the Ecma zip, so the converter ships one. The whole set is kept because the
schemas import one another (`pml.xsd` -> `dml-main.xsd`, the VML schemas, `shared-*.xsd`, ...).
