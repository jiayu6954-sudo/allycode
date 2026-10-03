import unittest
from openpyxl import Workbook
from excel_formulas import formula_value, validate_formulas


class FormulaBoundaries(unittest.TestCase):
    def workbook(self, expression):
        wb=Workbook();ws=wb.active;ws.title='数据';ws.append(['输入','公式']);ws.append([3,expression])
        return wb, [{'sheet':'数据','cell':'B2','formula':expression}]

    def test_blocks_external_names_and_unbounded_or_cyclic_references(self):
        for expression in ['=WEBSERVICE("https://example.com")','=INDIRECT("A2")', "='[other.xlsx]表'!A1", '=SUM(A:A)', '=NamedRange', '=A999', '=B2', '=A0']:
            with self.subTest(expression=expression):
                wb,specs=self.workbook(expression)
                with self.assertRaises(ValueError):validate_formulas(wb,specs)

    def test_local_absolute_and_cross_sheet_references(self):
        wb,specs=self.workbook("=ROUND('参数'!$A$2*A2,2)")
        wb.create_sheet('参数').append(['单价']);wb['参数'].append([10])
        validate_formulas(wb,specs)

    def test_formula_metadata_and_xlookup_do_not_rewrite_literal_strings(self):
        expression,_,_=formula_value({'formula':'=IF(1=1,"XLOOKUP(","other")','resultType':'text','expected':'XLOOKUP(','explanation':'条件返回原文'})
        self.assertIn('"XLOOKUP("',expression)
        self.assertNotIn('_xlfn.',expression)
        with self.assertRaises(ValueError):formula_value({'formula':'=1+1','expected':'2','explanation':'','resultType':'decimal'})
        with self.assertRaises(ValueError):formula_value({'formula':'=1+1','expected':'2','explanation':'test','tolerance':'999'})


if __name__=='__main__':unittest.main()
